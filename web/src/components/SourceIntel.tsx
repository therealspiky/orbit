import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { Citation } from './Citation';
import { ErrorNote } from './ui';
import { clock } from '../lib/format';
import { useOrg } from '../lib/org';
import { FLAG_LABEL, PROMISE_LABEL, usePeopleDirectory, type PostShowReport, type Promise_, type RecallFlag } from '../lib/spec';
import { check, supabase } from '../lib/supabase';
import { EDITOR_ROLES, type Segment, type Source } from '../lib/types';

/** One archive citation looked up by source and passage number (used by recall flags). */
export function CitationRef({ sourceId, idx }: { sourceId: string; idx: number }) {
  const q = useQuery({
    queryKey: ['cite', sourceId, idx],
    queryFn: async () => check(await supabase.from('transcript_segments')
      .select('text,start_ms,end_ms,speaker,person_id,sources(title,show_id,created_at)').eq('source_id', sourceId).eq('idx', idx).maybeSingle()) as
      { text: string; start_ms: number | null; end_ms: number | null; speaker: string | null; sources: { title: string; show_id: string | null; created_at: string } | null } | null,
  });
  const { showName } = useOrg();
  if (!q.data) return <p className="text-[13px] text-ink-faint">{q.isLoading ? 'Loading citation…' : 'Citation not visible to you.'}</p>;
  return <Citation compact sourceId={sourceId} quote={q.data.text} startMs={q.data.start_ms} endMs={q.data.end_ms} speaker={q.data.speaker}
    showName={q.data.sources?.show_id ? showName(q.data.sources.show_id) : null} date={q.data.sources?.created_at} sourceTitle={q.data.sources?.title} />;
}

/** Map speaker labels to people records, retroactively for the whole source. */
export function SpeakerMap({ source, segments, canEdit, onSaved }: { source: Source; segments: Segment[]; canEdit: boolean; onSaved: () => void }) {
  const { org } = useOrg();
  const dir = usePeopleDirectory(org?.id);
  const labels = [...new Set(segments.map((s) => s.speaker).filter((x): x is string => !!x))];
  const current = (label: string) => (segments.find((s) => s.speaker === label) as Segment & { person_id?: string | null })?.person_id ?? '';
  const map = useMutation({
    mutationFn: async (a: { label: string; person: string }) =>
      check(await supabase.rpc('map_speaker', { p_source: source.id, p_label: a.label, p_person: a.person || null })),
    onSuccess: onSaved,
  });
  if (!labels.length) {
    return (
      <div className="panel p-4 text-sm">
        <h2 className="font-semibold mb-1">Speakers</h2>
        <p className="text-ink-faint">This transcript has no speaker labels. Diarised transcription (Deepgram) adds them; local transcription does not.</p>
      </div>
    );
  }
  return (
    <div className="panel p-4 text-sm">
      <h2 className="font-semibold mb-2">Speakers</h2>
      <ul className="space-y-2">
        {labels.map((l) => (
          <li key={l} className="flex items-center gap-2">
            <span className="w-24 shrink-0 font-semibold truncate" title={l}>{l}</span>
            <select className="field-input py-1" disabled={!canEdit || map.isPending} value={current(l)} aria-label={`Person for ${l}`}
              onChange={(e) => map.mutate({ label: l, person: e.target.value })}>
              <option value="">Unidentified</option>
              {(dir.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.display_name}</option>)}
            </select>
          </li>
        ))}
      </ul>
      <p className="text-[12px] text-ink-faint mt-2">Not in the list? <Link to="/people" className="underline">Add them on People</Link>.</p>
      <ErrorNote error={map.error} />
    </div>
  );
}

/** Post-show report, recall flags and promise candidates for one source. */
export function SourceIntelligence({ source, canEdit }: { source: Source; canEdit: boolean }) {
  const { can } = useOrg();
  const canReviewFlags = can([...EDITOR_ROLES, 'producer', 'legal_reviewer'], source.brand_id, source.show_id);
  const report = useQuery({
    queryKey: ['post-show', source.id],
    queryFn: async () => check(await supabase.from('post_show_reports').select('*').eq('source_id', source.id).order('created_at', { ascending: false }).limit(1).maybeSingle()) as PostShowReport | null,
  });
  const flags = useQuery({
    queryKey: ['flags', source.id],
    queryFn: async () => check(await supabase.from('recall_flags').select('*').eq('source_id', source.id).neq('status', 'dismissed').order('created_at')) as RecallFlag[],
  });
  const promises = useQuery({
    queryKey: ['source-promises', source.id],
    queryFn: async () => check(await supabase.from('promise_board').select('*').eq('source_id', source.id).neq('status', 'dismissed').order('segment_start')) as Promise_[],
  });
  const accept = useMutation({
    mutationFn: async () => check(await supabase.rpc('accept_post_show_report', { p_report: report.data!.id })),
    onSuccess: () => void report.refetch(),
  });
  const review = useMutation({
    mutationFn: async (a: { id: string; status: string }) => check(await supabase.rpc('review_recall_flag', { p_flag: a.id, p_status: a.status })),
    onSuccess: () => void flags.refetch(),
  });
  const [showAll, setShowAll] = useState(false);
  const r = report.data;
  const fl = flags.data ?? [];
  const shownFlags = showAll ? fl : fl.slice(0, 6);
  if (!r && !fl.length && !promises.data?.length) return null;

  return (
    <section className="space-y-4">
      {r && (
        <div className="panel p-4 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
            <h2 className="text-lg font-semibold">Post-show report <span className="text-[12px] font-normal text-ink-faint">{r.status === 'accepted' ? 'Accepted' : 'Draft, needs a producer to accept'}</span></h2>
            {canEdit && r.status === 'draft' && <button className="btn btn-quiet" disabled={accept.isPending} onClick={() => accept.mutate()}>Accept report</button>}
          </div>
          <p className="source-text text-[15px] mb-3">{r.body.summary}</p>
          {r.body.unanswered_questions.length > 0 && (
            <div className="mb-3"><h3 className="font-semibold">Unanswered questions for a follow-up</h3>
              <ul className="list-disc pl-5">{r.body.unanswered_questions.map((q, i) => <li key={i}>{q.question} <span className="text-ink-faint">[{q.segment_start}–{q.segment_end}]</span></li>)}</ul>
            </div>
          )}
          {r.body.clip_candidates.length > 0 && (
            <div className="mb-3"><h3 className="font-semibold">Clip candidates</h3>
              <ul className="list-disc pl-5">{r.body.clip_candidates.map((c, i) => <li key={i}>“{c.quote}” <span className="text-ink-faint">[{c.segment_start}–{c.segment_end}] {c.why}</span></li>)}</ul>
            </div>
          )}
          {r.body.next_actions.length > 0 && (
            <div><h3 className="font-semibold">Next actions</h3><ul className="list-disc pl-5">{r.body.next_actions.map((a, i) => <li key={i}>{a}</li>)}</ul></div>
          )}
          <ErrorNote error={accept.error} />
        </div>
      )}

      {fl.length > 0 && (
        <div className="panel p-4 text-sm">
          <h2 className="text-lg font-semibold mb-1">Archive flags</h2>
          <p className="text-[13px] text-ink-soft mb-3">Links to what was said before. A possible tension is a prompt for an editor to judge, never a claim to publish.</p>
          <div className="space-y-4">
            {shownFlags.map((f) => (
              <div key={f.id} className="border-t border-line pt-3 first:border-0 first:pt-0">
                <p><span className="font-bold">{FLAG_LABEL[f.kind]}</span>{f.status === 'confirmed_for_review' && <span className="ml-2 text-[12px] text-ink-faint">Marked for editorial review</span>} · {f.summary}</p>
                <div className="mt-2 space-y-2">{f.citations.slice(0, 2).map((c) => <CitationRef key={`${c.source_id}-${c.idx}`} sourceId={c.source_id} idx={c.idx} />)}</div>
                {canReviewFlags && f.status === 'open' && (
                  <div className="flex gap-2 mt-2">
                    <button className="btn btn-quiet btn-sm" onClick={() => review.mutate({ id: f.id, status: 'confirmed_for_review' })}>Worth raising</button>
                    <button className="btn btn-quiet btn-sm" onClick={() => review.mutate({ id: f.id, status: 'dismissed' })}>Dismiss</button>
                  </div>
                )}
              </div>
            ))}
          </div>
          {fl.length > 6 && <button className="btn btn-quiet btn-sm mt-3" onClick={() => setShowAll(!showAll)}>{showAll ? 'Show fewer' : `Show all ${fl.length}`}</button>}
          <ErrorNote error={review.error} />
        </div>
      )}

      {(promises.data?.length ?? 0) > 0 && (
        <div className="panel p-4 text-sm">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-lg font-semibold">Promises made on air</h2>
            <Link to="/promises" className="underline">Promise board</Link>
          </div>
          <ul className="space-y-2">
            {promises.data!.map((p) => (
              <li key={p.id}>
                <span className="text-[12px] font-bold mr-2">{PROMISE_LABEL[p.status]}</span>
                “{p.verbatim_text}” <span className="text-ink-faint">{clock(p.start_ms)}{p.due_phrase ? ` · said “${p.due_phrase}”` : ''}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
