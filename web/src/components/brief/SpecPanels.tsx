import { useMutation, useQuery } from '@tanstack/react-query';
import { AlertTriangle, Download, Film, Music, RefreshCw, Search } from 'lucide-react';
import { useState } from 'react';
import { clock } from '../../lib/format';
import { useOrg, usePeople } from '../../lib/org';
import {
  FLAG_LABEL, PROMISE_LABEL, signedDownload, useSignedUrl, usePeopleDirectory,
  type Clip, type Contribution, type Finding, type Promise_, type RecallFlag, type RecallHit, type ResearchQuery,
} from '../../lib/spec';
import { check, supabase } from '../../lib/supabase';
import type { Brief, BriefContent, Segment, Source } from '../../lib/types';
import { Citation, ExternalLabel } from '../Citation';
import { Empty, ErrorNote } from '../ui';

// ---------------------------------------------------------------------------
// Studio: captioned clips rendered from the corrected transcript (US-030)
// ---------------------------------------------------------------------------
export function StudioPanel({ brief, content, segments, source, canWork }: {
  brief: Brief; content: BriefContent; segments: Segment[]; source: Source | null; canWork: boolean;
}) {
  const clips = useQuery({
    queryKey: ['clips', brief.id],
    refetchInterval: (q) => ((q.state.data as Clip[] | undefined)?.some((c) => ['queued', 'rendering'].includes(c.status)) ? 3000 : false),
    queryFn: async () => check(await supabase.from('clips').select('*').eq('brief_id', brief.id).order('created_at')) as Clip[],
  });
  const [start, setStart] = useState<number | ''>('');
  const [end, setEnd] = useState<number | ''>('');
  const create = useMutation({
    mutationFn: async (a: { s: number; e: number; headline: string; social?: number | null }) => {
      const id = check(await supabase.rpc('create_clip', { p_brief: brief.id, p_segment_start: a.s, p_segment_end: a.e,
        p_aspect: '9:16', p_headline: a.headline.slice(0, 120), p_social_index: a.social ?? null })) as string;
      check(await supabase.rpc('request_clip_render', { p_clip: id }));
    },
    onSuccess: () => void clips.refetch(),
  });
  const canClip = !!source && source.kind === 'recording' && !!source.storage_path && source.timestamps_genuine;
  const candidates = content.social_package.map((a, i) => ({ a, i })).filter(({ a }) => a.clip_candidate);
  const made = new Set((clips.data ?? []).map((c) => c.social_index));

  return (
    <div className="space-y-6">
      <p className="text-ink-soft max-w-[70ch]">
        Clips are cut from the source recording at transcript times and captioned from the corrected transcript. Rendering is automatic;
        nothing is posted anywhere. Downloads become part of the export once the brief is approved.
      </p>
      {!canClip && <Empty title="No recording to cut from">This brief's source is a transcript or notes without genuine timings, so clips cannot be rendered. Add the recording as a source.</Empty>}
      {canClip && canWork && candidates.length > 0 && (
        <div className="panel p-4">
          <h3 className="font-semibold mb-2">Clip candidates in the social package</h3>
          <ul className="space-y-2">
            {candidates.map(({ a, i }) => (
              <li key={i} className="flex flex-wrap items-center justify-between gap-3">
                <span className="min-w-0"><span className="font-semibold">{a.platform} {a.asset_type.replace('_', ' ')}</span>: {a.hook}
                  <span className="text-ink-faint text-sm"> (passages {a.clip_candidate!.segment_start}–{a.clip_candidate!.segment_end})</span></span>
                <button className="btn btn-quiet btn-sm" disabled={made.has(i) || create.isPending}
                  onClick={() => create.mutate({ s: a.clip_candidate!.segment_start, e: a.clip_candidate!.segment_end, headline: a.hook, social: i })}>
                  <Film size={14} aria-hidden /> {made.has(i) ? 'Clip created' : 'Render vertical clip'}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {canClip && canWork && (
        <div className="panel p-4 flex flex-wrap items-end gap-3">
          <label className="text-sm"><span className="block font-semibold mb-1">From passage</span>
            <input type="number" min={0} className="field-input w-28" value={start} onChange={(e) => setStart(e.target.value === '' ? '' : Number(e.target.value))} /></label>
          <label className="text-sm"><span className="block font-semibold mb-1">To passage</span>
            <input type="number" min={0} className="field-input w-28" value={end} onChange={(e) => setEnd(e.target.value === '' ? '' : Number(e.target.value))} /></label>
          <button className="btn btn-primary" disabled={start === '' || end === '' || create.isPending}
            onClick={() => create.mutate({ s: Number(start), e: Number(end), headline: content.title })}>New clip from transcript</button>
          {start !== '' && end !== '' && (
            <p className="w-full source-text text-[15px] text-ink-soft">
              {segments.filter((x) => x.idx >= Number(start) && x.idx <= Number(end)).map((x) => x.text).join(' ') || 'No passages in that range.'}
            </p>
          )}
        </div>
      )}
      <ErrorNote error={create.error} />
      <div className="grid gap-4 md:grid-cols-2">
        {(clips.data ?? []).map((c) => <ClipCard key={c.id} clip={c} canWork={canWork} onChanged={() => void clips.refetch()} />)}
      </div>
    </div>
  );
}

function ClipCard({ clip, canWork, onChanged }: { clip: Clip; canWork: boolean; onChanged: () => void }) {
  const fresh = clip.status === 'rendered' && clip.rendered_revision === clip.revision;
  const url = useSignedUrl(fresh ? clip.video_path : null);
  const [headline, setHeadline] = useState(clip.headline);
  const [caption, setCaption] = useState(clip.caption_text);
  const [aspect, setAspect] = useState(clip.aspect_ratio);
  const dirty = headline !== clip.headline || caption !== clip.caption_text || aspect !== clip.aspect_ratio;
  const save = useMutation({
    mutationFn: async () => {
      check(await supabase.rpc('update_clip', { p_clip: clip.id, p_headline: headline, p_caption_text: caption, p_aspect: aspect }));
      check(await supabase.rpc('request_clip_render', { p_clip: clip.id }));
    },
    onSuccess: onChanged,
  });
  const rerender = useMutation({ mutationFn: async () => check(await supabase.rpc('request_clip_render', { p_clip: clip.id })), onSuccess: onChanged });
  const busy = ['queued', 'rendering'].includes(clip.status);
  return (
    <article className="panel p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold">{clip.aspect_ratio} clip · {clock(clip.start_ms)}–{clock(clip.end_ms)}</p>
        <span className="text-[12px] font-semibold">{busy ? 'Rendering…' : clip.status === 'failed' ? 'Render failed' : fresh ? 'Rendered' : 'Needs render'}</span>
      </div>
      {url.data && <video src={url.data} controls className={`w-full rounded-md bg-black ${clip.aspect_ratio === '9:16' ? 'max-h-[420px]' : ''}`} />}
      {clip.render_error && <ErrorNote error={clip.render_error} />}
      {clip.caption_differs && (
        <p className="text-[13px] bg-signal-soft rounded px-2 py-1 flex gap-1.5"><AlertTriangle size={14} aria-hidden className="mt-0.5 shrink-0" />
          Caption differs from transcript. An editor must check it against the audio.</p>
      )}
      {clip.music_flag && (
        <p className="text-[13px] bg-signal-soft rounded px-2 py-1 flex gap-1.5"><Music size={14} aria-hidden className="mt-0.5 shrink-0" />
          Audio may contain music or other non-speech ({clip.music_ranges.map((r) => `${clock(r.start_ms)}–${clock(r.end_ms)}`).join(', ')}). Review rights before publishing. Not cleared.</p>
      )}
      {canWork && (
        <div className="space-y-2">
          <label className="block text-sm"><span className="font-semibold">Headline</span>
            <input className="field-input mt-1" maxLength={120} value={headline} onChange={(e) => setHeadline(e.target.value)} /></label>
          <label className="block text-sm"><span className="font-semibold">Captions</span>
            <textarea className="field-input mt-1 source-text text-[14px]" value={caption} onChange={(e) => setCaption(e.target.value)} /></label>
          <div className="flex flex-wrap items-center gap-2">
            <select className="field-input w-auto" value={aspect} onChange={(e) => setAspect(e.target.value as Clip['aspect_ratio'])} aria-label="Aspect ratio">
              <option value="9:16">Vertical 9:16</option><option value="16:9">Landscape 16:9</option><option value="1:1">Square 1:1</option>
            </select>
            <button className="btn btn-primary btn-sm" disabled={!dirty || busy || save.isPending} onClick={() => save.mutate()}>Save and re-render</button>
            {!dirty && !busy && !fresh && <button className="btn btn-quiet btn-sm" onClick={() => rerender.mutate()}><RefreshCw size={13} aria-hidden /> Render</button>}
          </div>
          <ErrorNote error={save.error ?? rerender.error} />
        </div>
      )}
      {fresh && (
        <div className="flex flex-wrap gap-2 text-sm">
          <button className="btn btn-quiet btn-sm" onClick={() => void signedDownload(clip.video_path!, `clip-${clip.id.slice(0, 8)}.mp4`)}><Download size={13} aria-hidden /> MP4</button>
          <button className="btn btn-quiet btn-sm" onClick={() => void signedDownload(clip.srt_path!, `clip-${clip.id.slice(0, 8)}.srt`)}>SRT</button>
          <button className="btn btn-quiet btn-sm" onClick={() => void signedDownload(clip.vtt_path!, `clip-${clip.id.slice(0, 8)}.vtt`)}>VTT</button>
        </div>
      )}
    </article>
  );
}

// ---------------------------------------------------------------------------
// Archive Recall panel: related quotes, open promises and flags (verified archive only)
// ---------------------------------------------------------------------------
export function ArchivePanel({ brief, content }: { brief: Brief; content: BriefContent }) {
  const { org } = useOrg();
  const [q, setQ] = useState(content.title.replace(/[?!.:"“”]/g, ''));
  const [query, setQuery] = useState(q);
  const hits = useQuery({
    queryKey: ['recall', org?.id, query, brief.origin_source_id],
    enabled: !!org && query.trim().length > 2,
    queryFn: async () => check(await supabase.rpc('recall_search', { p_org: org!.id, p_query: query.split(/\s+/).filter((w) => w.length > 3).join(' or '),
      p_exclude_source: brief.origin_source_id, p_limit: 20 })) as RecallHit[],
  });
  const flags = useQuery({
    queryKey: ['flags', brief.origin_source_id], enabled: !!brief.origin_source_id,
    queryFn: async () => check(await supabase.from('recall_flags').select('*').eq('source_id', brief.origin_source_id!).neq('status', 'dismissed')) as RecallFlag[],
  });
  const promises = useQuery({
    queryKey: ['promises-src', brief.origin_source_id], enabled: !!brief.origin_source_id,
    queryFn: async () => check(await supabase.from('promise_board').select('*').eq('source_id', brief.origin_source_id!).neq('status', 'dismissed')) as Promise_[],
  });
  return (
    <div className="space-y-6">
      <p className="text-ink-soft max-w-[70ch]">From our archive: real, timestamped quotes in this organisation that you are allowed to see. Flags are for editorial review and never go into captions or headlines.</p>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); setQuery(q); }}>
        <input className="field-input" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Topic to recall" />
        <button className="btn btn-quiet"><Search size={14} aria-hidden /> Recall</button>
      </form>
      <section>
        <h3 className="font-semibold mb-2">Related quotes from other programmes</h3>
        {hits.data?.length === 0 && <p className="text-ink-faint text-sm">No archive matches were found.</p>}
        <div className="space-y-3">
          {(hits.data ?? []).map((h) => (
            <Citation key={`${h.source_id}-${h.segment_idx}`} sourceId={h.source_id} quote={h.quote} startMs={h.start_ms} endMs={h.end_ms}
              speaker={h.speaker} personName={h.person_name} showName={h.show_name} brandName={h.brand_name} date={h.aired_on} sourceTitle={h.source_title} compact />
          ))}
        </div>
        <ErrorNote error={hits.error} />
      </section>
      <section>
        <h3 className="font-semibold mb-2">Promises in the source</h3>
        {promises.data?.length === 0 && <p className="text-ink-faint text-sm">No promise candidates in this source.</p>}
        <ul className="space-y-2">
          {(promises.data ?? []).map((p) => (
            <li key={p.id} className="panel p-3 text-sm"><span className="font-semibold">{PROMISE_LABEL[p.status]}{p.is_overdue ? ' · overdue' : ''}</span>
              {p.due_on && <> · due {p.due_on}</>} <span className="source-text">“{p.verbatim_text}”</span></li>
          ))}
        </ul>
      </section>
      <section>
        <h3 className="font-semibold mb-2">Archive flags</h3>
        {flags.data?.length === 0 && <p className="text-ink-faint text-sm">No flags.</p>}
        <ul className="space-y-2">
          {(flags.data ?? []).map((f) => (
            <li key={f.id} className="panel p-3 text-sm"><span className="font-semibold">{FLAG_LABEL[f.kind]}</span>: {f.summary}
              <span className="text-ink-faint"> ({f.citations.length} cited passages)</span></li>
          ))}
        </ul>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// External research panel: separate, labelled, editor-confirmed (US-044)
// ---------------------------------------------------------------------------
export function ExternalPanel({ brief, canWork, canEditorial }: { brief: Brief; canWork: boolean; canEditorial: boolean }) {
  const { org } = useOrg();
  const [q, setQ] = useState('');
  const queries = useQuery({
    queryKey: ['research', brief.id],
    refetchInterval: (s) => ((s.state.data as ResearchQuery[] | undefined)?.some((x) => x.status === 'queued') ? 3000 : false),
    queryFn: async () => check(await supabase.from('web_research_queries').select('*').eq('brief_id', brief.id).order('created_at', { ascending: false })) as ResearchQuery[],
  });
  const findings = useQuery({
    queryKey: ['findings', brief.id, queries.dataUpdatedAt],
    enabled: !!queries.data?.length,
    queryFn: async () => check(await supabase.from('external_findings').select('*').in('query_id', queries.data!.map((x) => x.id)).order('retrieved_at', { ascending: false })) as Finding[],
  });
  const run = useMutation({
    mutationFn: async () => check(await supabase.rpc('request_web_research', { p_org: org!.id, p_query: q, p_context_type: 'brief', p_context_id: brief.id })),
    onSuccess: () => { setQ(''); void queries.refetch(); },
  });
  const review = useMutation({
    mutationFn: async (a: { id: string; decision: 'confirmed_for_use' | 'rejected' }) =>
      check(await supabase.rpc('review_finding', { p_finding: a.id, p_decision: a.decision, p_brief: brief.id })),
    onSuccess: () => void findings.refetch(),
  });
  return (
    <div className="space-y-5">
      <p className="text-ink-soft max-w-[70ch]">Outside context from the web: news coverage, official statements, announcements. These are <strong>not</strong> archive quotes. An editor must confirm a finding before it can be used in the brief, a script or a graphic; confirmed findings keep their external label in exports.</p>
      {canWork && (
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (q.trim().length > 2) run.mutate(); }}>
          <input className="field-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. Asafo Road drainage contract" aria-label="Web research query" />
          <button className="btn btn-quiet" disabled={run.isPending}><Search size={14} aria-hidden /> Find external context</button>
        </form>
      )}
      <ErrorNote error={run.error ?? review.error} />
      {(queries.data ?? []).filter((x) => x.status !== 'done').map((x) => (
        <p key={x.id} className="text-sm text-ink-soft">“{x.query_text}”: {x.status === 'queued' ? 'searching…' : `failed — ${x.error ?? 'see job'}`}</p>
      ))}
      <ul className="space-y-3">
        {(findings.data ?? []).map((f) => (
          <li key={f.id} className="border border-dashed border-line-strong rounded-md p-3 bg-paper">
            <ExternalLabel />
            <p className="mt-1.5 font-semibold"><a href={f.url} target="_blank" rel="noreferrer noopener" className="underline">{f.title}</a></p>
            <p className="text-[13px] text-ink-soft">{f.publisher} · {f.published_on ? `published ${f.published_on}` : 'publication date unknown'} · retrieved {new Date(f.retrieved_at).toLocaleDateString()}</p>
            <p className="text-sm mt-1">{f.excerpt}</p>
            <div className="mt-2 flex items-center gap-2 text-sm">
              <span className="font-semibold">{f.status === 'confirmed_for_use' ? 'Confirmed for use on this brief' : f.status === 'rejected' ? 'Rejected' : 'Not confirmed: cannot be used'}</span>
              {canEditorial && f.status === 'retrieved' && <>
                <button className="btn btn-approve btn-sm" onClick={() => review.mutate({ id: f.id, decision: 'confirmed_for_use' })}>Confirm for use</button>
                <button className="btn btn-quiet btn-sm" onClick={() => review.mutate({ id: f.id, decision: 'rejected' })}>Reject</button>
              </>}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Credits, owner approval and export (US-050, US-031, US-032)
// ---------------------------------------------------------------------------
export function CreditsExportPanel({ brief, canWork, canEditorial, canOwner, onChanged, exportCopy }: {
  brief: Brief & { owner_approved_at?: string | null; exported_at?: string | null };
  canWork: boolean; canEditorial: boolean; canOwner: boolean; onChanged: () => void;
  exportCopy: (pkg: Record<string, unknown>) => void;
}) {
  const { org } = useOrg();
  const person = usePeople();
  const dir = usePeopleDirectory(org?.id);
  const credits = useQuery({
    queryKey: ['credits', brief.id],
    queryFn: async () => check(await supabase.from('contributions').select('*').eq('object_type', 'brief').eq('object_id', brief.id).order('created_at')) as Contribution[],
  });
  const needsOwner = useQuery({
    queryKey: ['owner-needed', brief.id, brief.status],
    queryFn: async () => check(await supabase.rpc('owner_approval_needed', { p_brief: brief.id })) as boolean,
  });
  const [pid, setPid] = useState('');
  const [role, setRole] = useState('produced');
  const edit = useMutation({
    mutationFn: async (a: { person: string; role: string; remove?: boolean }) =>
      check(await supabase.rpc('set_contribution', { p_type: 'brief', p_object: brief.id, p_person: a.person, p_role: a.role, p_remove: !!a.remove })),
    onSuccess: () => void credits.refetch(),
  });
  const ownerApprove = useMutation({
    mutationFn: async () => check(await supabase.rpc('owner_approve_brief', { p_brief: brief.id })),
    onSuccess: () => { onChanged(); void credits.refetch(); },
  });
  const exportPkg = useMutation({
    mutationFn: async () => check(await supabase.rpc('export_brief_package', { p_brief: brief.id })) as Record<string, unknown>,
    onSuccess: (pkg) => { exportCopy(pkg); onChanged(); void credits.refetch(); },
  });
  const approvedish = ['approved', 'scheduled', 'produced', 'closed'].includes(brief.status);
  const name = (c: Contribution) => (c.person_id ? dir.data?.find((p) => p.id === c.person_id)?.display_name : null) ?? person(c.user_id);
  return (
    <div className="space-y-6">
      <section>
        <h3 className="font-semibold mb-2">Credit ledger</h3>
        <p className="text-sm text-ink-soft mb-3">Who sourced, produced, edited and approved this work. Credits come from workflow actions; editors can correct them before export. After export, changes are logged as amendments.</p>
        <ul className="divide-y divide-line panel">
          {(credits.data ?? []).map((c) => (
            <li key={c.id} className="px-3 py-2 flex items-center justify-between gap-2 text-sm">
              <span><span className="font-semibold capitalize">{c.role}</span> · {name(c)}{c.locked_at ? ' · locked' : ''}</span>
              {canEditorial && c.person_id && <button className="text-blocked text-[13px]" onClick={() => edit.mutate({ person: c.person_id!, role: c.role, remove: true })}>Remove</button>}
            </li>
          ))}
          {credits.data?.length === 0 && <li className="px-3 py-2 text-sm text-ink-faint">No credits yet.</li>}
        </ul>
        {canEditorial && (
          <div className="mt-3 flex flex-wrap gap-2">
            <select className="field-input w-auto" value={pid} onChange={(e) => setPid(e.target.value)} aria-label="Person">
              <option value="">Add a person…</option>
              {(dir.data ?? []).filter((p) => p.kind === 'staff').map((p) => <option key={p.id} value={p.id}>{p.display_name}</option>)}
            </select>
            <select className="field-input w-auto" value={role} onChange={(e) => setRole(e.target.value)} aria-label="Credit role">
              {['sourced', 'produced', 'edited', 'approved'].map((r) => <option key={r}>{r}</option>)}
            </select>
            <button className="btn btn-quiet" disabled={!pid} onClick={() => edit.mutate({ person: pid, role })}>Add credit</button>
          </div>
        )}
        <ErrorNote error={edit.error} />
      </section>
      <section className="panel p-4 space-y-3">
        <h3 className="font-semibold">Approval and export</h3>
        <ol className="text-sm space-y-1 list-decimal pl-5">
          <li>Editorial approval: {approvedish ? 'done' : 'not yet (Review and approval tab)'}</li>
          <li>Owner approval: {needsOwner.data ? (brief.owner_approved_at ? `given ${new Date(brief.owner_approved_at).toLocaleString()}` : 'required, not yet given') : 'not required for this show'}</li>
          <li>Export: {brief.exported_at ? `exported ${new Date(brief.exported_at).toLocaleString()}` : 'not exported'}. No posting to social platforms; files only.</li>
        </ol>
        <div className="flex flex-wrap gap-2">
          {canOwner && needsOwner.data && approvedish && !brief.owner_approved_at && (
            <button className="btn btn-approve" onClick={() => ownerApprove.mutate()}>Give owner approval</button>
          )}
          {canWork && <button className="btn btn-primary" disabled={!approvedish || exportPkg.isPending} onClick={() => exportPkg.mutate()}>
            <Download size={14} aria-hidden /> Export approved package</button>}
        </div>
        <ErrorNote error={ownerApprove.error ?? exportPkg.error} />
      </section>
    </div>
  );
}
