import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Config } from '../config.js';
import { audit, must, type Db } from '../lib/db.js';
import type { LlmClient } from '../lib/llm.js';
import { UNTRUSTED } from '../lib/prompts.js';
import type { Analysis } from '../lib/schemas.js';
import type { Segment, SourceRow } from '../types.js';

/**
 * Post-analysis intelligence for one transcript version (spec §6.6 Mode B, §6.7, §6.11):
 *   - promise candidates from verified commitment quotes,
 *   - recall flags: prior statements, recurring topics (exact counts), open promises, possible tensions,
 *   - the lightweight post-show report.
 * Everything is cited to real segments. Nothing here is published; it is all for editors to review.
 */
export interface IntelDeps { db: Db; cfg: Config; llm: LlmClient }

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

function iso(d: Date) { return d.toISOString().slice(0, 10); }

/**
 * A suggested due date from spoken words, relative to the air date. Only clear phrases are parsed;
 * anything else returns null so a producer sets the date. Never authoritative.
 */
export function suggestDueDate(phrase: string | null | undefined, airDate: Date): string | null {
  if (!phrase) return null;
  const p = phrase.toLowerCase();
  const base = new Date(Date.UTC(airDate.getUTCFullYear(), airDate.getUTCMonth(), airDate.getUTCDate()));
  const add = (n: number) => { const d = new Date(base); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
  if (/\btoday\b|\btonight\b/.test(p)) return add(0);
  if (/\btomorrow\b/.test(p)) return add(1);
  const day = DAYS.findIndex((d) => p.includes(d));
  if (day >= 0) {
    let diff = (day - base.getUTCDay() + 7) % 7;
    if (diff === 0 || /\bnext\b/.test(p)) diff += diff === 0 ? 7 : (/\bnext\b/.test(p) && diff < 7 ? 7 : 0);
    return add(diff);
  }
  if (/\bnext week\b/.test(p)) return add(7);
  if (/\bend of (the )?month\b/.test(p)) return iso(new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)));
  const dayMonth = [...p.matchAll(/(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]+)/g)].map((m) => [m[1], m[2]] as const);
  const monthDay = [...p.matchAll(/([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?\b/g)].map((m) => [m[2], m[1]] as const);
  for (const [dd, mm] of [...dayMonth, ...monthDay]) {
    const dayN = Number(dd); const mon = MONTHS.indexOf((mm ?? '').toLowerCase());
    if (mon >= 0 && dayN >= 1 && dayN <= 31) {
      let d = new Date(Date.UTC(base.getUTCFullYear(), mon, dayN));
      if (d < base) d = new Date(Date.UTC(base.getUTCFullYear() + 1, mon, dayN));
      return iso(d);
    }
  }
  return null;
}

export function fingerprint(...parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
}

interface PriorSeg { source_id: string; idx: number; text: string; start_ms: number | null; person_id: string | null }

/** Sources another show may cite: organisation-shared, or same brand / same show per its scope. */
export function canCiteAcross(prior: Pick<SourceRow, 'share_scope' | 'brand_id' | 'show_id'>, current: Pick<SourceRow, 'brand_id' | 'show_id'>): boolean {
  if (prior.share_scope === 'organisation') return true;
  if (prior.share_scope === 'brand') return prior.brand_id === current.brand_id;
  return prior.show_id !== null && prior.show_id === current.show_id;
}

const TensionSchema = z.object({
  tensions: z.array(z.object({
    current_segment: z.number().int().min(0).describe('Segment number in the CURRENT transcript'),
    prior_ref: z.string().regex(/^P\d+$/).describe('Reference of the earlier statement, e.g. P3'),
    note: z.string().max(240).describe('Neutral description of the possible tension for an editor; not a claim that anyone lied.'),
  })),
});

export async function runIntelligence(deps: IntelDeps, src: SourceRow, segments: Segment[], analysis: Analysis) {
  const { db } = deps;
  const fp = fingerprint(segments.map((s) => [s.idx, s.speaker, s.text]));
  const segPeople = must(await db.from('transcript_segments').select('idx,person_id').eq('source_id', src.id), 'segment people') as
    { idx: number; person_id: string | null }[];
  const personAt = new Map(segPeople.map((s) => [s.idx, s.person_id]));
  const byIdx = new Map(segments.map((s) => [s.idx, s]));
  const air = src.episode_id
    ? (await db.from('episodes').select('air_date').eq('id', src.episode_id).maybeSingle()).data?.air_date as string | null
    : null;
  const airDate = air ? new Date(`${air}T00:00:00Z`) : new Date();

  // ---- Promise candidates -------------------------------------------------
  let promises = 0;
  for (const c of analysis.commitments ?? []) {
    const first = byIdx.get(c.segment_start); const last = byIdx.get(c.segment_end);
    const row = {
      org_id: src.org_id, brand_id: src.brand_id, show_id: src.show_id, source_id: src.id,
      segment_start: c.segment_start, segment_end: c.segment_end,
      start_ms: src.timestamps_genuine ? first?.start_ms ?? null : null, end_ms: src.timestamps_genuine ? last?.end_ms ?? null : null,
      verbatim_text: c.quote, normalized_text: c.summary, speaker_label: c.speaker,
      person_id: personAt.get(c.segment_start) ?? null, due_phrase: c.due_phrase,
      suggested_due_on: suggestDueDate(c.due_phrase, airDate),
      fingerprint: fingerprint('promise', c.segment_start, c.segment_end, c.quote.toLowerCase()),
    };
    const r = await db.from('promises').upsert(row, { onConflict: 'source_id,fingerprint', ignoreDuplicates: true }).select('id');
    if (r.error) throw new Error(`promise candidate: ${r.error.message}`);
    promises += (r.data ?? []).length;
  }

  // ---- Recall flags --------------------------------------------------------
  const orgSources = must(await db.from('sources').select('id,brand_id,show_id,share_scope,title,created_at,status')
    .eq('org_id', src.org_id).neq('id', src.id).in('status', ['ready', 'needs_attention']), 'org sources') as
    (Pick<SourceRow, 'id' | 'brand_id' | 'show_id' | 'share_scope' | 'title'> & { created_at: string })[];
  const citable = orgSources.filter((s) => canCiteAcross(s, src));
  const citableIds = citable.map((s) => s.id);
  const flags: Record<string, unknown>[] = [];
  const flag = (kind: string, summary: string, citations: { source_id: string; idx: number }[], extra: Record<string, unknown> = {}) =>
    flags.push({ org_id: src.org_id, source_id: src.id, kind, summary, citations, fingerprint: fingerprint(kind, citations, extra.topic ?? null), ...extra });

  const people = [...new Set(segPeople.map((s) => s.person_id).filter((x): x is string => !!x))];
  const names = new Map<string, string>();
  if (people.length) {
    for (const p of must(await db.from('people').select('id,display_name').in('id', people), 'people') as { id: string; display_name: string }[]) {
      names.set(p.id, p.display_name);
    }
  }
  const priorByPerson = new Map<string, PriorSeg[]>();
  for (const pid of people) {
    const first = segPeople.find((s) => s.person_id === pid)!.idx;
    if (citableIds.length) {
      const prior = must(await db.from('transcript_segments').select('source_id,idx,text,start_ms,person_id')
        .eq('org_id', src.org_id).eq('person_id', pid).in('source_id', citableIds).order('source_id').limit(40), 'prior statements') as PriorSeg[];
      priorByPerson.set(pid, prior);
      const sourcesWith = new Set(prior.map((p) => p.source_id));
      if (prior.length) {
        flag('prior_statement', `${names.get(pid) ?? 'This person'} has ${prior.length} earlier statement(s) in ${sourcesWith.size} archived programme(s).`,
          [{ source_id: src.id, idx: first }, ...prior.slice(0, 5).map((p) => ({ source_id: p.source_id, idx: p.idx }))],
          { person_id: pid, topic_count: sourcesWith.size });
      }
    }
    const open = must(await db.from('promises').select('id,source_id,segment_start,verbatim_text,due_on')
      .eq('org_id', src.org_id).eq('person_id', pid).in('status', ['confirmed', 'nudge_sent']).neq('source_id', src.id), 'open promises') as
      { id: string; source_id: string; segment_start: number; verbatim_text: string; due_on: string | null }[];
    for (const op of open.filter((o) => citableIds.includes(o.source_id))) {
      flag('open_promise', `${names.get(pid) ?? 'This person'} has an open promise${op.due_on ? ` due ${op.due_on}` : ''}.`,
        [{ source_id: src.id, idx: first }, { source_id: op.source_id, idx: op.segment_start }], { person_id: pid });
    }
  }

  // Recurring topics: exact count of earlier programmes in the last 12 months that mention the theme.
  const since = new Date(Date.now() - 365 * 86400_000).toISOString();
  const recent = new Set(citable.filter((s) => s.created_at >= since).map((s) => s.id));
  for (const t of analysis.themes.slice(0, 8)) {
    if (!recent.size) break;
    const hits = await db.from('transcript_segments').select('source_id,idx')
      .eq('org_id', src.org_id).in('source_id', [...recent])
      .textSearch('tsv', t.theme, { type: 'websearch', config: 'english' }).limit(200);
    if (hits.error) throw new Error(`topic recall: ${hits.error.message}`);
    const rows = (hits.data ?? []) as { source_id: string; idx: number }[];
    const n = new Set(rows.map((r) => r.source_id)).size;
    if (n >= 1) {
      const firstPer = [...new Map(rows.map((r) => [r.source_id, r])).values()].slice(0, 5);
      flag('recurring_topic', `"${t.theme}" also came up in ${n} other programme(s) in the past 12 months.`,
        [{ source_id: src.id, idx: t.segment_start }, ...firstPer], { topic: t.theme, topic_count: n });
    }
  }

  // Possible tensions with earlier statements: a model proposal, stored only as an editor flag (G4).
  let tensions = 0;
  if (deps.cfg.anthropicKey) {
    for (const pid of people) {
      const prior = (priorByPerson.get(pid) ?? []).slice(0, 25);
      const mine = segments.filter((s) => personAt.get(s.idx) === pid);
      if (!prior.length || !mine.length) continue;
      const res = await deps.llm.structured({
        model: deps.cfg.analysisModel,
        system: `You compare what one person said in a new programme with their earlier statements in the same media organisation's archive.
Identify only clear factual or positional tensions an editor should check (for example a deadline that moved, a figure that changed,
a position reversed). Do not judge honesty and do not call anything a lie or a contradiction; these are flags for human review.
Return an empty list when nothing clearly conflicts.\n${UNTRUSTED}`,
        user: `CURRENT PROGRAMME\n${mine.map((s) => `[${s.idx}] ${s.text}`).join('\n')}\n\nEARLIER STATEMENTS\n${prior.map((p, i) => `P${i + 1}: ${p.text}`).join('\n')}`,
        toolName: 'record_tensions', toolDescription: 'Record possible tensions for editorial review.',
        schema: TensionSchema, maxTokens: 2000,
      });
      for (const t of res.value.tensions) {
        const p = prior[Number(t.prior_ref.slice(1)) - 1];
        if (!p || personAt.get(t.current_segment) !== pid) continue; // both citations must be real and this person's
        tensions++;
        flag('contradiction_candidate', `Possible tension — review: ${t.note}`,
          [{ source_id: src.id, idx: t.current_segment }, { source_id: p.source_id, idx: p.idx }], { person_id: pid });
      }
    }
  }

  if (flags.length) {
    const r = await db.from('recall_flags').upsert(flags, { onConflict: 'source_id,fingerprint', ignoreDuplicates: true });
    if (r.error) throw new Error(`recall flags: ${r.error.message}`);
  }

  // ---- Post-show report (draft until a producer accepts it) ---------------
  const quote = (a: number, b: number) => segments.filter((s) => s.idx >= a && s.idx <= b).map((s) => s.text).join(' ');
  const speakers = [...new Set(segments.map((s) => s.speaker).filter(Boolean))].map((label) => {
    const idx = segments.find((s) => s.speaker === label)!.idx;
    const pid = personAt.get(idx);
    return { label, person_id: pid ?? null, name: pid ? names.get(pid) ?? null : null,
      segments: segments.filter((s) => s.speaker === label).length };
  });
  const body = {
    summary: analysis.summary,
    topics: analysis.themes.map((t) => ({ theme: t.theme, segment_start: t.segment_start, segment_end: t.segment_end })),
    speakers,
    unanswered_questions: (analysis.follow_up_questions ?? []).map((q) => ({ ...q, quote: quote(q.segment_start, q.segment_end) })),
    promise_candidates: (analysis.commitments ?? []).map((c) => ({ quote: c.quote, due_phrase: c.due_phrase, segment_start: c.segment_start })),
    recall_flags: flags.reduce<Record<string, number>>((acc, f) => { acc[f.kind as string] = (acc[f.kind as string] ?? 0) + 1; return acc; }, {}),
    clip_candidates: analysis.usable_moments.map((m) => ({ ...m, quote: quote(m.segment_start, m.segment_end) })),
    next_actions: [
      ...(analysis.commitments?.length ? ['Confirm or dismiss the promise candidates'] : []),
      ...(flags.length ? ['Review the archive flags before using them'] : []),
      'Choose destination shows and generate briefs',
    ],
  };
  const rep = await db.from('post_show_reports').upsert({ org_id: src.org_id, source_id: src.id, transcript_fingerprint: fp, body },
    { onConflict: 'source_id,transcript_fingerprint' });
  if (rep.error) throw new Error(`post-show report: ${rep.error.message}`);
  await audit(db, src.org_id, 'source.intelligence', 'source', src.id, { promises, flags: flags.length, tensions });
  return { promise_candidates: promises, recall_flags: flags.length, tensions };
}
