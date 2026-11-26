import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Bell, Calculator, Search } from 'lucide-react';
import { useState } from 'react';
import { Citation } from '../components/Citation';
import { BriefBadge, Empty, ErrorNote, Field, PageHeader, Spinner } from '../components/ui';
import { ago } from '../lib/format';
import { useOrg } from '../lib/org';
import { usePeopleDirectory, type ApprovedMetric, type Metric, type Notification, type RecallHit } from '../lib/spec';
import { check, supabase } from '../lib/supabase';
import type { Brief } from '../lib/types';

// ---------------------------------------------------------------------------
// Topic and person recall (US-042): archive quotes only, permission filtered in the database.
// ---------------------------------------------------------------------------
export function RecallPage() {
  const { org, shows } = useOrg();
  const dir = usePeopleDirectory(org?.id);
  const [form, setForm] = useState({ q: '', person: '', show: '', from: '', to: '' });
  const [run, setRun] = useState<typeof form | null>(null);
  const hits = useQuery({
    queryKey: ['recall', org?.id, run], enabled: !!org && !!run && (!!run.q.trim() || !!run.person),
    queryFn: async () => check(await supabase.rpc('recall_search', {
      p_org: org!.id, p_query: run!.q || null, p_person: run!.person || null, p_show: run!.show || null,
      p_from: run!.from || null, p_to: run!.to || null, p_limit: 100,
    })) as RecallHit[],
  });
  return (
    <>
      <PageHeader title="Archive recall" lede="Find what was said on air, by topic or by person, across every brand you can see. Every result is a verbatim transcript passage with its time and a player." />
      <form className="panel p-4 mb-6 grid gap-3 md:grid-cols-[2fr_1.2fr_1.2fr_1fr_1fr_auto] items-end" onSubmit={(e) => { e.preventDefault(); setRun({ ...form }); }}>
        <Field label="Topic or words"><input className="field-input" value={form.q} onChange={(e) => setForm({ ...form, q: e.target.value })} placeholder="e.g. galamsey, fuel prices" /></Field>
        <Field label="Person">
          <select className="field-input" value={form.person} onChange={(e) => setForm({ ...form, person: e.target.value })}>
            <option value="">Anyone</option>{(dir.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.display_name}</option>)}
          </select>
        </Field>
        <Field label="Show">
          <select className="field-input" value={form.show} onChange={(e) => setForm({ ...form, show: e.target.value })}>
            <option value="">All shows</option>{shows.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="From"><input type="date" className="field-input" value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} /></Field>
        <Field label="To"><input type="date" className="field-input" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} /></Field>
        <button className="btn btn-primary" disabled={!form.q.trim() && !form.person}><Search size={14} aria-hidden /> Search</button>
      </form>
      <ErrorNote error={hits.error} />
      {!run ? null : hits.isLoading ? <Spinner /> : hits.data?.length ? (
        <div className="space-y-2">
          <p className="text-[13px] text-ink-soft">{hits.data.length} passages{hits.data.length === 100 ? ' (first 100)' : ''}</p>
          {hits.data.map((h) => (
            <Citation key={`${h.source_id}-${h.segment_idx}`} compact sourceId={h.source_id} quote={h.quote} startMs={h.start_ms} endMs={h.end_ms}
              speaker={h.speaker} personName={h.person_name} showName={h.show_name} brandName={h.brand_name} date={h.aired_on} sourceTitle={h.source_title} />
          ))}
        </div>
      ) : <Empty title="No archive passages match">Nothing in the sources you can see matches. Try other words or a wider date range.</Empty>}
    </>
  );
}

// ---------------------------------------------------------------------------
// Metrics and scorecards (spec §7.7): no figure without evidence; only approved figures are shown.
// ---------------------------------------------------------------------------
interface Episode { id: string; title: string; air_date: string | null; show_id: string; brand_id: string }
const TYPE_LABEL: Record<string, string> = { airtime_ms: 'Airtime', reach: 'Reach', engagement: 'Engagement', revenue: 'Revenue' };

function fmt(type: string, v: number, unit: string, currency: string | null) {
  if (type === 'airtime_ms') { const m = Math.round(v / 60000); return `${m} min`; }
  if (type === 'revenue') return `${currency ?? ''} ${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  return `${Math.round(v).toLocaleString()} ${unit}`;
}

export function MetricsPage() {
  const { org, can, showName } = useOrg();
  const dir = usePeopleDirectory(org?.id);
  const canEnter = can(['org_admin', 'brand_editor', 'show_editor', 'producer']);
  const episodes = useQuery({
    queryKey: ['episodes', org?.id], enabled: !!org,
    queryFn: async () => check(await supabase.from('episodes').select('id,title,air_date,show_id,brand_id').eq('org_id', org!.id).order('air_date', { ascending: false, nullsFirst: false }).limit(200)) as Episode[],
  });
  const approved = useQuery({
    queryKey: ['approved-metrics', org?.id], enabled: !!org,
    queryFn: async () => check(await supabase.from('approved_person_metrics').select('*').eq('org_id', org!.id)) as ApprovedMetric[],
  });
  const pending = useQuery({
    queryKey: ['pending-metrics', org?.id], enabled: !!org && canEnter,
    queryFn: async () => check(await supabase.from('metric_observations').select('*').eq('org_id', org!.id).eq('status', 'pending_approval').order('created_at')) as Metric[],
  });
  const refresh = () => { void approved.refetch(); void pending.refetch(); };
  const [ep, setEp] = useState('');
  const [f, setF] = useState({ person: '', type: 'reach', value: '', unit: 'listeners', platform: '', currency: 'GHS', evidence_type: 'upload', url: '', note: '', definition: '' });
  const airtime = useMutation({
    mutationFn: async () => check(await supabase.rpc('compute_airtime', { p_episode: ep })) as number,
    onSuccess: refresh,
  });
  const submit = useMutation({
    mutationFn: async () => check(await supabase.rpc('submit_metric', {
      p_episode: ep, p_person: f.person || null, p_type: f.type, p_value: Number(f.value), p_unit: f.unit, p_platform: f.platform || null,
      p_evidence_type: f.evidence_type, p_evidence_url: f.url || null, p_evidence_path: null, p_note: f.note || null,
      p_currency: f.type === 'revenue' ? f.currency : null, p_definition: f.definition || null,
    })),
    onSuccess: () => { setF({ ...f, value: '', url: '', note: '' }); refresh(); },
  });
  const review = useMutation({
    mutationFn: async (a: { id: string; ok: boolean; reason?: string }) => check(await supabase.rpc('review_metric', { p_metric: a.id, p_approve: a.ok, p_reason: a.reason ?? null })),
    onSuccess: refresh,
  });
  const epName = (id: string) => episodes.data?.find((e) => e.id === id)?.title ?? 'Episode';
  const pname = (id: string | null) => dir.data?.find((p) => p.id === id)?.display_name ?? 'Whole episode';

  // Scorecard: approved figures per person, per metric type.
  const byPerson = new Map<string, Map<string, { v: number; unit: string; currency: string | null; n: number }>>();
  for (const m of approved.data ?? []) {
    if (!m.person_id) continue;
    const row = byPerson.get(m.person_id) ?? new Map();
    const cur = row.get(m.metric_type) ?? { v: 0, unit: m.unit, currency: m.currency, n: 0 };
    cur.v += Number(m.attributed_value ?? 0); cur.n += 1; row.set(m.metric_type, cur); byPerson.set(m.person_id, row);
  }
  const staff = (dir.data ?? []).filter((p) => p.kind === 'staff');
  const types = ['airtime_ms', 'reach', 'engagement', 'revenue'];

  return (
    <>
      <PageHeader title="Scorecards" lede="Per presenter and producer. Only approved figures appear, each traceable to its evidence. Where a figure is credited to an episode rather than a person, it is split equally between that episode's credited presenters and producers." />

      <section className="panel overflow-x-auto mb-8">
        <table className="w-full text-sm">
          <thead className="text-left text-ink-soft"><tr className="border-b border-line">
            <th className="px-4 py-2 font-semibold">Person</th>{types.map((t) => <th key={t} className="px-4 py-2 font-semibold">{TYPE_LABEL[t]}</th>)}
          </tr></thead>
          <tbody>
            {staff.length ? staff.map((p) => (
              <tr key={p.id} className="border-b border-line last:border-0">
                <td className="px-4 py-2.5 font-semibold"><Link to="/people/$personId" params={{ personId: p.id }} className="hover:underline">{p.display_name}</Link></td>
                {types.map((t) => {
                  const c = byPerson.get(p.id)?.get(t);
                  return <td key={t} className="px-4 py-2.5">{c ? <>{fmt(t, c.v, c.unit, c.currency)}<span className="block text-[12px] text-ink-faint">{c.n} approved figure{c.n > 1 ? 's' : ''}</span></> : <span className="text-ink-faint">No approved figure</span>}</td>;
                })}
              </tr>
            )) : <tr><td className="px-4 py-4 text-ink-faint" colSpan={5}>Add presenters and producers as staff on the People page.</td></tr>}
          </tbody>
        </table>
      </section>

      {canEnter && (
        <section className="panel p-4 mb-8">
          <h2 className="font-semibold mb-3">Add a figure</h2>
          <div className="grid gap-3 md:grid-cols-3">
            <Field label="Episode">
              <select className="field-input" value={ep} onChange={(e) => setEp(e.target.value)}>
                <option value="">Choose…</option>
                {(episodes.data ?? []).map((e) => <option key={e.id} value={e.id}>{e.title} · {showName(e.show_id)}{e.air_date ? ` · ${e.air_date}` : ''}</option>)}
              </select>
            </Field>
            <div className="flex items-end">
              <button className="btn btn-quiet" disabled={!ep || airtime.isPending} onClick={() => airtime.mutate()}><Calculator size={14} aria-hidden /> Compute airtime from transcript</button>
            </div>
            <p className="text-[12px] text-ink-faint self-end">{airtime.data != null ? `${airtime.data} airtime figure(s) submitted for approval.` : 'Airtime uses mapped speakers on recordings with real timestamps.'}</p>
            <Field label="Credited to">
              <select className="field-input" value={f.person} onChange={(e) => setF({ ...f, person: e.target.value })}>
                <option value="">Whole episode (split equally)</option>{(dir.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.display_name}</option>)}
              </select>
            </Field>
            <Field label="Metric">
              <select className="field-input" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value, unit: { reach: 'listeners', engagement: 'interactions', revenue: 'amount' }[e.target.value] ?? f.unit })}>
                <option value="reach">Reach</option><option value="engagement">Engagement</option><option value="revenue">Revenue</option>
              </select>
            </Field>
            <Field label="Value"><input className="field-input" type="number" min={0} value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} /></Field>
            <Field label="Platform"><input className="field-input" value={f.platform} onChange={(e) => setF({ ...f, platform: e.target.value })} placeholder="e.g. FM, YouTube, Facebook" /></Field>
            {f.type === 'revenue' && <Field label="Currency"><input className="field-input" value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })} /></Field>}
            <Field label="Definition"><input className="field-input" value={f.definition} onChange={(e) => setF({ ...f, definition: e.target.value })} placeholder="e.g. 7-day unique viewers" /></Field>
            <Field label="Evidence type">
              <select className="field-input" value={f.evidence_type} onChange={(e) => setF({ ...f, evidence_type: e.target.value })}>
                <option value="upload">Report or screenshot link</option><option value="platform_api">Platform analytics link</option>
                <option value="csv_import">Spreadsheet link</option><option value="manual_entry">Manual entry with link</option>
              </select>
            </Field>
            <Field label="Evidence link" help="Required. A figure without evidence cannot be submitted.">
              <input className="field-input" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} placeholder="https://…" />
            </Field>
            <Field label="Note"><input className="field-input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
          </div>
          <button className="btn btn-primary mt-3" disabled={!ep || f.value === '' || !f.url.trim() || submit.isPending} onClick={() => submit.mutate()}>Submit for approval</button>
          <div className="mt-2"><ErrorNote error={submit.error ?? airtime.error} /></div>
        </section>
      )}

      {canEnter && (
        <section>
          <h2 className="font-semibold mb-2">Waiting for approval</h2>
          {pending.data?.length ? (
            <div className="panel divide-y divide-line">
              {pending.data.map((m) => (
                <div key={m.id} className="px-4 py-3 flex flex-wrap items-center gap-3 text-sm">
                  <span className="font-semibold">{TYPE_LABEL[m.metric_type]}: {fmt(m.metric_type, Number(m.value), m.unit, m.currency)}</span>
                  <span className="text-ink-soft">{epName(m.episode_id)} · {pname(m.person_id)}{m.platform ? ` · ${m.platform}` : ''}</span>
                  {m.evidence_url ? <a href={m.evidence_url} target="_blank" rel="noreferrer noopener" className="underline">Evidence</a> : <span className="text-ink-faint">Computed from transcript</span>}
                  <span className="text-ink-faint">{ago(m.created_at)}</span>
                  <span className="flex-1" />
                  <button className="btn btn-primary" onClick={() => review.mutate({ id: m.id, ok: true })}>Approve</button>
                  <button className="btn btn-quiet" onClick={() => { const r = window.prompt('Reason for rejecting'); if (r) review.mutate({ id: m.id, ok: false, reason: r }); }}>Reject</button>
                </div>
              ))}
            </div>
          ) : <p className="text-sm text-ink-faint">Nothing waiting.</p>}
          <ErrorNote error={review.error} />
        </section>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Sales inventory (spec §5 wall): commercial staff see approved plans only, never drafts or sources.
// ---------------------------------------------------------------------------
export function InventoryPage() {
  const { org, showName, brandName } = useOrg();
  const q = useQuery({
    queryKey: ['inventory', org?.id], enabled: !!org,
    queryFn: async () => check(await supabase.from('briefs').select('*').eq('org_id', org!.id)
      .in('status', ['approved', 'scheduled', 'produced']).order('updated_at', { ascending: false }).limit(300)) as Brief[],
  });
  return (
    <>
      <PageHeader title="Approved inventory" lede="Editorially approved plans that are open for sponsorship conversations. Drafts, sources and unapproved plans are not shown here." />
      {q.isLoading ? <Spinner /> : q.data?.length ? (
        <div className="panel divide-y divide-line">
          {q.data.map((b) => (
            <div key={b.id} className="px-4 py-3 flex flex-wrap items-center gap-3">
              <span className="font-semibold">{b.title}</span>
              <span className="text-[13px] text-ink-soft">{showName(b.show_id)} · {brandName(b.brand_id)}</span>
              <BriefBadge status={b.status} />
            </div>
          ))}
        </div>
      ) : <Empty title="No approved plans yet">Plans appear here once an editor approves them.</Empty>}
    </>
  );
}

// ---------------------------------------------------------------------------
// Notifications (assignment, approvals, failed jobs, promise nudges)
// ---------------------------------------------------------------------------
export function useNotifications() {
  const { org, userId } = useOrg();
  return useQuery({
    queryKey: ['notifications', org?.id, userId], enabled: !!org && !!userId, refetchInterval: 60_000,
    queryFn: async () => check(await supabase.from('notifications').select('*').eq('org_id', org!.id).order('created_at', { ascending: false }).limit(100)) as Notification[],
  });
}

export function NotificationsPage() {
  const n = useNotifications();
  const markAll = useMutation({
    mutationFn: async () => check(await supabase.from('notifications').update({ read_at: new Date().toISOString() }).is('read_at', null).select('id')),
    onSuccess: () => void n.refetch(),
  });
  return (
    <>
      <PageHeader title="Notifications" actions={<button className="btn btn-quiet" onClick={() => markAll.mutate()}><Bell size={14} aria-hidden /> Mark all read</button>} />
      {n.isLoading ? <Spinner /> : n.data?.length ? (
        <div className="panel divide-y divide-line">
          {n.data.map((x) => (
            <div key={x.id} className={`px-4 py-3 ${x.read_at ? '' : 'bg-surface'}`}>
              <p className={x.read_at ? '' : 'font-semibold'}>{x.link ? <a href={x.link} className="hover:underline">{x.title}</a> : x.title}</p>
              {x.body && <p className="text-sm text-ink-soft">{x.body}</p>}
              <p className="text-[12px] text-ink-faint">{ago(x.created_at)}</p>
            </div>
          ))}
        </div>
      ) : <Empty title="Nothing yet">You will be told here when a brief is assigned to you, approved, or a promise you track falls due.</Empty>}
    </>
  );
}
