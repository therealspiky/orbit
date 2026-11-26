import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Citation } from '../components/Citation';
import { Empty, ErrorNote, PageHeader, Spinner } from '../components/ui';
import { useOrg } from '../lib/org';
import { PROMISE_LABEL, usePeopleDirectory, type Promise_ } from '../lib/spec';
import { check, supabase } from '../lib/supabase';
import { WORK_ROLES } from '../lib/types';

type Filter = 'candidate' | 'tracked' | 'overdue' | 'closed';

/** Promise tracker (spec §6.10): candidates need a producer to confirm; resolution needs evidence. */
export function PromisesPage() {
  const { org, showName, can } = useOrg();
  const dir = usePeopleDirectory(org?.id);
  const [filter, setFilter] = useState<Filter>('tracked');
  const board = useQuery({
    queryKey: ['promises', org?.id, filter], enabled: !!org,
    queryFn: async () => {
      let r = supabase.from('promise_board').select('*').eq('org_id', org!.id).order('due_on', { ascending: true, nullsFirst: false }).limit(300);
      if (filter === 'candidate') r = r.eq('status', 'candidate');
      if (filter === 'tracked') r = r.in('status', ['confirmed', 'nudge_sent']);
      if (filter === 'overdue') r = r.eq('is_overdue', true);
      if (filter === 'closed') r = r.in('status', ['fulfilled', 'broken', 'dismissed']);
      return check(await r) as Promise_[];
    },
  });
  const personName = (id: string | null) => dir.data?.find((p) => p.id === id)?.display_name ?? null;

  return (
    <>
      <PageHeader title="Promises" lede="Commitments made on air. The system suggests candidates from the transcript; a producer confirms what is tracked, and closing one needs evidence (a later archive passage or a confirmed outside source)." />
      <div className="flex flex-wrap gap-2 mb-4" role="tablist">
        {(['candidate', 'tracked', 'overdue', 'closed'] as Filter[]).map((f) => (
          <button key={f} role="tab" aria-selected={filter === f} className={`btn ${filter === f ? 'btn-primary' : 'btn-quiet'}`} onClick={() => setFilter(f)}>
            {{ candidate: 'To confirm', tracked: 'Tracked', overdue: 'Overdue', closed: 'Closed' }[f]}
          </button>
        ))}
      </div>
      {board.isLoading ? <Spinner /> : board.data?.length ? (
        <div className="space-y-4">
          {board.data.map((p) => (
            <PromiseCard key={p.id} p={p} who={personName(p.person_id)} show={showName(p.show_id)}
              canWork={can(WORK_ROLES, p.brand_id, p.show_id)} onChanged={() => void board.refetch()} />
          ))}
        </div>
      ) : <Empty title="Nothing here">Promise candidates appear after a source is transcribed and analysed.</Empty>}
    </>
  );
}

function PromiseCard({ p, who, show, canWork, onChanged }: { p: Promise_; who: string | null; show: string; canWork: boolean; onChanged: () => void }) {
  const { org } = useOrg();
  const dir = usePeopleDirectory(org?.id);
  const [due, setDue] = useState(p.due_on ?? p.suggested_due_on ?? '');
  const [person, setPerson] = useState(p.person_id ?? '');
  const [reason, setReason] = useState('');
  const [mode, setMode] = useState<'none' | 'resolve' | 'dismiss'>('none');
  const [outcome, setOutcome] = useState<'fulfilled' | 'broken'>('fulfilled');
  const [note, setNote] = useState('');
  const [evSource, setEvSource] = useState('');
  const [evSeg, setEvSeg] = useState<number | ''>('');
  const sources = useQuery({
    queryKey: ['sources-pick', org?.id], enabled: mode === 'resolve',
    queryFn: async () => check(await supabase.from('sources').select('id,title,created_at').eq('org_id', org!.id).order('created_at', { ascending: false }).limit(100)) as { id: string; title: string }[],
  });
  const act = useMutation({
    mutationFn: async (kind: 'confirm' | 'dismiss' | 'resolve') => {
      if (kind === 'confirm') return check(await supabase.rpc('confirm_promise', { p_promise: p.id, p_due_on: due, p_person: person || null }));
      if (kind === 'dismiss') return check(await supabase.rpc('dismiss_promise', { p_promise: p.id, p_reason: reason }));
      return check(await supabase.rpc('resolve_promise', {
        p_promise: p.id, p_outcome: outcome, p_note: note, p_source: evSource || null, p_segment: evSeg === '' ? null : evSeg,
      }));
    },
    onSuccess: () => { setMode('none'); onChanged(); },
  });

  return (
    <article className="panel p-4">
      <div className="flex flex-wrap items-center gap-2 mb-2 text-[13px]">
        <span className={`font-bold rounded px-1.5 py-0.5 ${p.is_overdue ? 'bg-blocked text-white' : 'bg-line'}`}>{p.is_overdue ? 'Overdue' : PROMISE_LABEL[p.status]}</span>
        <span className="text-ink-soft">{show}</span>
        {p.due_on ? <span>Due {p.due_on}</span> : p.due_phrase && <span className="text-ink-soft">Said: “{p.due_phrase}”{p.suggested_due_on ? ` (suggested ${p.suggested_due_on})` : ''}</span>}
      </div>
      <Citation compact sourceId={p.source_id} quote={p.verbatim_text} startMs={p.start_ms} endMs={p.end_ms} speaker={p.speaker_label} personName={who} />
      {p.resolution_note && <p className="text-sm mt-2"><span className="font-semibold">Outcome:</span> {p.resolution_note}</p>}
      {canWork && p.status === 'candidate' && (
        <div className="flex flex-wrap items-end gap-2 mt-3">
          <label className="text-sm">Due date<input type="date" className="field-input" value={due} onChange={(e) => setDue(e.target.value)} /></label>
          <label className="text-sm">Who made it
            <select className="field-input" value={person} onChange={(e) => setPerson(e.target.value)}>
              <option value="">Not linked</option>
              {(dir.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.display_name}</option>)}
            </select>
          </label>
          <button className="btn btn-primary" disabled={!due || act.isPending} onClick={() => act.mutate('confirm')}>Track this promise</button>
          <button className="btn btn-quiet" onClick={() => setMode(mode === 'dismiss' ? 'none' : 'dismiss')}>Not a promise</button>
        </div>
      )}
      {canWork && ['confirmed', 'nudge_sent'].includes(p.status) && (
        <div className="flex flex-wrap gap-2 mt-3">
          <button className="btn btn-quiet" onClick={() => setMode(mode === 'resolve' ? 'none' : 'resolve')}>Record outcome</button>
          <button className="btn btn-quiet" onClick={() => setMode(mode === 'dismiss' ? 'none' : 'dismiss')}>Stop tracking</button>
        </div>
      )}
      {mode === 'dismiss' && (
        <div className="flex flex-wrap gap-2 mt-3">
          <input className="field-input flex-1 min-w-[220px]" placeholder="Why" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason" />
          <button className="btn btn-quiet" disabled={!reason.trim() || act.isPending} onClick={() => act.mutate('dismiss')}>Dismiss</button>
        </div>
      )}
      {mode === 'resolve' && (
        <div className="grid gap-2 md:grid-cols-2 mt-3">
          <select className="field-input" value={outcome} onChange={(e) => setOutcome(e.target.value as typeof outcome)} aria-label="Outcome">
            <option value="fulfilled">Kept</option><option value="broken">Broken or delayed</option>
          </select>
          <input className="field-input" placeholder="What happened" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note" />
          <select className="field-input" value={evSource} onChange={(e) => setEvSource(e.target.value)} aria-label="Evidence source">
            <option value="">Evidence: archive source…</option>
            {(sources.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
          </select>
          <input className="field-input" type="number" min={0} placeholder="Passage number in that source" value={evSeg}
            onChange={(e) => setEvSeg(e.target.value === '' ? '' : Number(e.target.value))} aria-label="Passage number" />
          <p className="text-[12px] text-ink-faint md:col-span-2">An outside source can also close a promise: confirm it for use in a brief's External research tab first.</p>
          <button className="btn btn-primary w-fit" disabled={!note.trim() || !evSource || evSeg === '' || act.isPending} onClick={() => act.mutate('resolve')}>Save outcome</button>
        </div>
      )}
      <div className="mt-2"><ErrorNote error={act.error} /></div>
    </article>
  );
}
