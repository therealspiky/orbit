import type { Config } from '../config.js';
import { audit, must, type Db } from '../lib/db.js';
import { PermanentError, type JobRow } from '../types.js';

/**
 * Web research layer (spec §6.8, US-044). Calls a server-side search API and stores each result as an
 * external finding: URL, publisher, title, published date (null when unknown — never invented),
 * retrieval time and a short excerpt. Findings stay in the External panel until an editor confirms one.
 */
export interface RawResult { url: string; title: string; excerpt: string; published: string | null; publisher?: string | null; raw: unknown }

export interface SearchProvider { name: string; search(query: string): Promise<RawResult[]> }

export function braveProvider(key: string): SearchProvider {
  return {
    name: 'brave',
    async search(query) {
      const u = new URL('https://api.search.brave.com/res/v1/web/search');
      u.searchParams.set('q', query); u.searchParams.set('count', '10');
      const res = await fetch(u, { headers: { 'X-Subscription-Token': key, Accept: 'application/json' } });
      if (!res.ok) throw new Error(`Brave search failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
      const body = (await res.json()) as { web?: { results?: any[] } };
      return (body.web?.results ?? []).map((r) => ({
        url: String(r.url ?? ''), title: String(r.title ?? ''), excerpt: String(r.description ?? ''),
        published: typeof r.page_age === 'string' ? r.page_age : null, publisher: r.profile?.name ?? r.meta_url?.hostname ?? null, raw: r,
      }));
    },
  };
}

export function tavilyProvider(key: string): SearchProvider {
  return {
    name: 'tavily',
    async search(query) {
      const res = await fetch('https://api.tavily.com/search', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ query, max_results: 10, search_depth: 'basic', include_answer: false }),
      });
      if (!res.ok) throw new Error(`Tavily search failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
      const body = (await res.json()) as { results?: any[] };
      return (body.results ?? []).map((r) => ({
        url: String(r.url ?? ''), title: String(r.title ?? ''), excerpt: String(r.content ?? ''),
        published: typeof r.published_date === 'string' ? r.published_date : null, publisher: null, raw: r,
      }));
    },
  };
}

export function makeSearchProvider(cfg: Config): SearchProvider | null {
  if (!cfg.searchApiKey) return null;
  return cfg.searchProvider === 'tavily' ? tavilyProvider(cfg.searchApiKey) : braveProvider(cfg.searchApiKey);
}

/** ISO date when the provider's value is a real, parseable date; otherwise null ("unknown"). */
export function parsePublished(v: string | null | undefined): string | null {
  if (!v) return null;
  const t = Date.parse(v);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  if (d.getUTCFullYear() < 1990 || d.getTime() > Date.now() + 86400_000) return null;
  return d.toISOString().slice(0, 10);
}

export function toFinding(r: RawResult, orgId: string, queryId: string) {
  let host: string;
  try {
    const u = new URL(r.url);
    if (!/^https?:$/.test(u.protocol)) return null;
    host = u.hostname.replace(/^www\./, '');
  } catch { return null; }
  const excerpt = r.excerpt.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  if (!r.title.trim() || !excerpt) return null;
  return {
    org_id: orgId, query_id: queryId, url: r.url, publisher: (r.publisher || host).slice(0, 120),
    title: r.title.replace(/<[^>]+>/g, '').trim().slice(0, 300),
    published_on: parsePublished(r.published),
    // Short excerpt only, never the full page (spec §6.8).
    excerpt: excerpt.length > 580 ? `${excerpt.slice(0, 577)}...` : excerpt,
    raw_payload: r.raw as object,
  };
}

export async function runWebResearch(job: JobRow, deps: { db: Db; cfg: Config; provider?: SearchProvider | null }) {
  const { db } = deps;
  const q = must(await db.from('web_research_queries').select('*').eq('id', String(job.payload.query_id ?? '')).single(), 'load query') as
    { id: string; org_id: string; query_text: string };
  if (q.org_id !== job.org_id) throw new PermanentError('Query belongs to another organisation');
  const provider = deps.provider === undefined ? makeSearchProvider(deps.cfg) : deps.provider;
  if (!provider) {
    await db.from('web_research_queries').update({ status: 'failed', error: 'Web search is not configured on this worker' }).eq('id', q.id);
    throw new PermanentError('Web search is not configured: set SEARCH_PROVIDER (brave or tavily) and SEARCH_API_KEY on the worker.');
  }
  const results = await provider.search(q.query_text);
  const rows = results.map((r) => toFinding(r, q.org_id, q.id)).filter((x): x is NonNullable<typeof x> => x !== null);
  if (rows.length) must(await db.from('external_findings').insert(rows).select('id'), 'store findings');
  await db.from('web_research_queries').update({ status: 'done', provider: provider.name, error: null }).eq('id', q.id);
  await audit(db, q.org_id, 'web_research.completed', 'web_research_query', q.id, { provider: provider.name, findings: rows.length });
  return { findings: rows.length, provider: provider.name };
}
