import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { Download, FileText, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { Citation } from '../components/Citation';
import { Empty, ErrorNote, Field, PageHeader, Spinner } from '../components/ui';
import { download } from '../lib/exportBrief';
import { clock } from '../lib/format';
import { useOrg } from '../lib/org';
import { usePeopleDirectory, type Person, type RecallHit } from '../lib/spec';
import { check, supabase } from '../lib/supabase';
import { WORK_ROLES } from '../lib/types';

const KIND: Record<Person['kind'], string> = { staff: 'Staff', guest: 'Guest', public_figure: 'Public figure', other: 'Other' };

/** People directory (spec §6.2): presenters, producers, guests and public figures, one identity across brands. */
export function PeoplePage() {
  const { org, can } = useOrg();
  const dir = usePeopleDirectory(org?.id);
  const [q, setQ] = useState('');
  const [form, setForm] = useState({ display_name: '', kind: 'guest' as Person['kind'], title: '', affiliation: '' });
  const canAdd = can(WORK_ROLES);
  const add = useMutation({
    mutationFn: async () => check(await supabase.from('people').insert({
      org_id: org!.id, display_name: form.display_name.trim(), kind: form.kind,
      title: form.title.trim() || null, affiliation: form.affiliation.trim() || null,
    })),
    onSuccess: () => { setForm({ display_name: '', kind: 'guest', title: '', affiliation: '' }); void dir.refetch(); },
  });
  const list = (dir.data ?? []).filter((p) => !q || `${p.display_name} ${p.affiliation ?? ''} ${p.title ?? ''}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <>
      <PageHeader title="People" lede="One record per person across every brand. Map transcript speakers to these records so recall, prep sheets and scorecards follow the person, not the speaker label." />
      {canAdd && (
        <form className="panel p-4 mb-6 grid gap-3 md:grid-cols-[2fr_1fr_1.5fr_1.5fr_auto] items-end"
          onSubmit={(e) => { e.preventDefault(); if (form.display_name.trim()) add.mutate(); }}>
          <Field label="Name"><input className="field-input" value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} /></Field>
          <Field label="Kind">
            <select className="field-input" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as Person['kind'] })}>
              {Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
          <Field label="Role or title"><input className="field-input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. MCE, Accra Metro" /></Field>
          <Field label="Organisation"><input className="field-input" value={form.affiliation} onChange={(e) => setForm({ ...form, affiliation: e.target.value })} /></Field>
          <button className="btn btn-primary" disabled={add.isPending || !form.display_name.trim()}><UserPlus size={14} aria-hidden /> Add</button>
          <div className="md:col-span-5"><ErrorNote error={add.error} /></div>
        </form>
      )}
      <input className="field-input mb-4 max-w-[360px]" placeholder="Search people" aria-label="Search people" value={q} onChange={(e) => setQ(e.target.value)} />
      {dir.isLoading ? <Spinner /> : list.length ? (
        <div className="panel divide-y divide-line">
          {list.map((p) => (
            <Link key={p.id} to="/people/$personId" params={{ personId: p.id }} className="flex flex-wrap items-baseline gap-x-3 px-4 py-3 hover:bg-line/40">
              <span className="font-semibold">{p.display_name}</span>
              <span className="text-[13px] text-ink-soft">{KIND[p.kind]}{p.title ? ` · ${p.title}` : ''}{p.affiliation ? `, ${p.affiliation}` : ''}</span>
              {p.anonymised_at && <span className="text-[12px] text-ink-faint">Anonymised</span>}
            </Link>
          ))}
        </div>
      ) : <Empty title="No people yet">Add presenters, producers and regular guests, then map speakers on a source page.</Empty>}
    </>
  );
}

interface PrepSheet {
  id: string; person_id: string; created_at: string; status: string;
  content: {
    person: { name: string; title: string | null; affiliation: string | null };
    quotes: RecallHit[];
    open_promises: { id: string; verbatim_text: string; due_on: string | null; status: string; source_id: string; start_ms: number | null }[];
    possible_tensions: { id: string; summary: string; status: string }[];
    empty: boolean; note: string;
  };
}

function prepToMarkdown(s: PrepSheet): string {
  const c = s.content;
  const L = [`# Guest prep: ${c.person.name}`, '', [c.person.title, c.person.affiliation].filter(Boolean).join(', '), '', `_${c.note}_`, '', '## Past on-air quotes', ''];
  if (!c.quotes.length) L.push('No archive appearances yet.');
  for (const q of c.quotes) L.push(`- "${q.quote}" (${q.show_name ?? q.source_title}, ${q.aired_on ?? 'date unknown'}, ${clock(q.start_ms)}–${clock(q.end_ms)})`);
  L.push('', '## Open promises', '');
  if (!c.open_promises.length) L.push('None tracked.');
  for (const p of c.open_promises) L.push(`- "${p.verbatim_text}" (due ${p.due_on ?? 'no date'})`);
  L.push('', '## Possible tensions (for editorial review, not claims)', '');
  if (!c.possible_tensions.length) L.push('None flagged.');
  for (const t of c.possible_tensions) L.push(`- ${t.summary}`);
  return L.join('\n') + '\n';
}

export function PersonPage() {
  const { personId } = useParams({ from: '/app/people/$personId' });
  const { org, can } = useOrg();
  const isAdmin = can(['org_admin']);
  const person = useQuery({
    queryKey: ['person', personId],
    queryFn: async () => check(await supabase.from('people').select('*').eq('id', personId).single()) as Person,
  });
  const hits = useQuery({
    queryKey: ['person-recall', personId], enabled: !!org,
    queryFn: async () => check(await supabase.rpc('recall_search', { p_org: org!.id, p_person: personId, p_limit: 100 })) as RecallHit[],
  });
  const sheets = useQuery({
    queryKey: ['prep', personId],
    queryFn: async () => check(await supabase.from('guest_prep_sheets').select('*').eq('person_id', personId).order('created_at', { ascending: false }).limit(10)) as PrepSheet[],
  });
  const build = useMutation({
    mutationFn: async () => check(await supabase.rpc('build_guest_prep', { p_person: personId })),
    onSuccess: () => void sheets.refetch(),
  });
  const exportData = useMutation({
    mutationFn: async () => check(await supabase.rpc('export_person_data', { p_person: personId })),
    onSuccess: (d) => download(`person-${personId}.json`, JSON.stringify(d, null, 2), 'application/json'),
  });
  const [reason, setReason] = useState('');
  const anon = useMutation({
    mutationFn: async () => check(await supabase.rpc('anonymise_person', { p_person: personId, p_reason: reason })),
    onSuccess: () => void person.refetch(),
  });

  if (person.error) return <ErrorNote error={person.error} />;
  const p = person.data;
  if (!p) return <Spinner />;
  const latest = sheets.data?.[0];

  return (
    <>
      <PageHeader title={p.display_name}
        lede={[KIND[p.kind], p.title, p.affiliation].filter(Boolean).join(' · ')}
        actions={<>
          <button className="btn btn-primary" disabled={build.isPending} onClick={() => build.mutate()}><FileText size={14} aria-hidden /> Build guest prep sheet</button>
          {isAdmin && <button className="btn btn-quiet" onClick={() => exportData.mutate()}><Download size={14} aria-hidden /> Export personal data</button>}
        </>} />
      <ErrorNote error={build.error ?? exportData.error} />

      {latest && (
        <section className="panel p-4 mb-6">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
            <h2 className="font-semibold">Latest prep sheet <span className="text-ink-faint font-normal text-[13px]">{new Date(latest.created_at).toLocaleString()}</span></h2>
            <button className="btn btn-quiet" onClick={() => download(`prep-${p.display_name.replace(/\W+/g, '-')}.md`, prepToMarkdown(latest))}><Download size={14} aria-hidden /> Download</button>
          </div>
          <p className="text-[13px] text-ink-soft mb-3">{latest.content.note}</p>
          <h3 className="text-sm font-semibold mt-2 mb-1">Open promises</h3>
          {latest.content.open_promises.length ? latest.content.open_promises.map((x) => (
            <Citation key={x.id} compact sourceId={x.source_id} quote={x.verbatim_text} startMs={x.start_ms} endMs={null} personName={p.display_name}
              date={x.due_on} sourceTitle={`Due ${x.due_on ?? 'no date'}`} />
          )) : <p className="text-sm text-ink-faint">None tracked.</p>}
          <h3 className="text-sm font-semibold mt-3 mb-1">Possible tensions (editorial review, not claims)</h3>
          {latest.content.possible_tensions.length ? (
            <ul className="list-disc pl-5 text-sm">{latest.content.possible_tensions.map((t) => <li key={t.id}>{t.summary}</li>)}</ul>
          ) : <p className="text-sm text-ink-faint">None flagged.</p>}
        </section>
      )}

      <h2 className="font-semibold mb-2">On-air appearances</h2>
      {hits.isLoading ? <Spinner /> : hits.data?.length ? (
        <div className="space-y-2">
          {hits.data.map((h) => (
            <Citation key={`${h.source_id}-${h.segment_idx}`} compact sourceId={h.source_id} quote={h.quote} startMs={h.start_ms} endMs={h.end_ms}
              speaker={h.speaker} personName={h.person_name} showName={h.show_name} brandName={h.brand_name} date={h.aired_on} sourceTitle={h.source_title} />
          ))}
        </div>
      ) : <Empty title="No appearances in the archive">Map this person to a speaker on a source page and their quotes will appear here.</Empty>}

      {isAdmin && !p.anonymised_at && (
        <section className="panel p-4 mt-8">
          <h2 className="font-semibold">Anonymise personal data</h2>
          <p className="text-[13px] text-ink-soft mb-2">For a data-subject request under Ghana's Data Protection Act. Removes name, contacts and profile details; broadcast recordings stay in the editorial archive.</p>
          <div className="flex flex-wrap gap-2">
            <input className="field-input flex-1 min-w-[220px]" placeholder="Reason, e.g. request received 26 Nov" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason" />
            <button className="btn btn-quiet" disabled={!reason.trim() || anon.isPending} onClick={() => anon.mutate()}>Anonymise</button>
          </div>
          <ErrorNote error={anon.error} />
        </section>
      )}
    </>
  );
}
