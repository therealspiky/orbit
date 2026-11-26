import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Pause, Play } from 'lucide-react';
import { useRef, useState } from 'react';
import { clock } from '../lib/format';
import { check, supabase } from '../lib/supabase';
import { useSignedUrl } from '../lib/spec';

/**
 * An archive citation: exact quote, speaker, programme, date, time range and a player that starts at the quote.
 * Archive quotes are always shown in this block; external web findings never use it (spec §10.6, G3).
 */
export function Citation(props: {
  sourceId: string; quote: string; startMs: number | null; endMs: number | null;
  speaker?: string | null; personName?: string | null; showName?: string | null; brandName?: string | null;
  date?: string | null; sourceTitle?: string | null; compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [playing, setPlaying] = useState(false);
  const media = useRef<HTMLAudioElement>(null);
  const src = useQuery({
    queryKey: ['citation-source', props.sourceId], enabled: open,
    queryFn: async () => check(await supabase.from('sources').select('id,storage_path,kind').eq('id', props.sourceId).maybeSingle()) as
      { id: string; storage_path: string | null; kind: string } | null,
  });
  const url = useSignedUrl(open && src.data?.kind === 'recording' ? src.data.storage_path : null);
  const who = props.personName ?? (props.speaker ? `${props.speaker} (unidentified speaker)` : 'Unidentified speaker');

  function toggle() {
    if (!open) { setOpen(true); return; }
    const m = media.current;
    if (!m) return;
    if (m.paused) { void m.play(); } else { m.pause(); }
  }

  return (
    <figure className={`border-l-4 border-ink/70 bg-surface rounded-r-md ${props.compact ? 'px-3 py-2' : 'px-4 py-3'}`}>
      <blockquote className="source-text">“{props.quote}”</blockquote>
      <figcaption className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-ink-soft">
        <span className="font-semibold text-ink">{who}</span>
        {(props.showName || props.brandName) && <span>{[props.showName, props.brandName].filter(Boolean).join(', ')}</span>}
        {props.date && <span>{new Date(props.date).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</span>}
        {props.startMs != null && <span>{clock(props.startMs)}–{clock(props.endMs)}</span>}
        {props.startMs != null && (
          <button className="inline-flex items-center gap-1 font-semibold text-ink hover:underline" onClick={toggle}
            aria-label={`Play source from ${clock(props.startMs)}`}>
            {playing ? <Pause size={12} aria-hidden /> : <Play size={12} aria-hidden />} {open ? (playing ? 'Pause' : 'Play') : 'Play source'}
          </button>
        )}
        <Link to="/sources/$sourceId" params={{ sourceId: props.sourceId }} className="underline">{props.sourceTitle ?? 'Open source'}</Link>
      </figcaption>
      {open && url.data && (
        <audio ref={media} src={url.data} controls className="w-full mt-2" autoPlay
          onLoadedMetadata={(e) => { if (props.startMs != null) e.currentTarget.currentTime = props.startMs / 1000; }}
          onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
          onTimeUpdate={(e) => { if (props.endMs != null && e.currentTarget.currentTime * 1000 > props.endMs + 1500) e.currentTarget.pause(); }} />
      )}
      {open && src.data && src.data.kind !== 'recording' && <p className="text-[12px] text-ink-faint mt-1">This source is a transcript without audio.</p>}
    </figure>
  );
}

/** Visually and textually distinct from archive citations (spec §10.6: not colour alone). */
export function ExternalLabel() {
  return (
    <span className="inline-block text-[11px] font-bold uppercase tracking-wide border border-dashed border-ink-faint text-ink-soft rounded px-1.5 py-0.5">
      External source — not an Orb.IT archive quote
    </span>
  );
}
