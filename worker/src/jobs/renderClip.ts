import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../config.js';
import { buildCues, nonSpeechRanges, parseSilences, toAss, toSrt, toVtt } from '../lib/captions.js';
import { audit, getSource, jobProgress, must, type Db } from '../lib/db.js';
import { probe, run, sha256File } from '../lib/media.js';
import { PermanentError, type JobRow } from '../types.js';

export interface RenderDeps { db: Db; cfg: Config }

export const RENDERER_VERSION = 'clip-render-v1';

interface ClipRow {
  id: string; org_id: string; brand_id: string; show_id: string; brief_id: string; source_id: string;
  segment_start: number; segment_end: number; start_ms: number; end_ms: number;
  aspect_ratio: '9:16' | '16:9' | '1:1'; caption_mode: 'burned' | 'sidecar';
  headline: string; caption_text: string; status: string; revision: number;
}

export function frameSize(aspect: ClipRow['aspect_ratio']): { width: number; height: number } {
  if (aspect === '16:9') return { width: 1920, height: 1080 };
  if (aspect === '1:1') return { width: 1080, height: 1080 };
  return { width: 1080, height: 1920 };
}

/** Brand colour from the show profile, then the brand profile (brand_kit.primary_colour). */
export function brandColour(showProfile: any, brandProfile: any): string | null {
  const pick = (p: any) => {
    const v = p?.brand_kit?.primary_colour ?? p?.identity?.primary_colour;
    return typeof v === 'string' && /^#?[0-9a-f]{6}$/i.test(v.trim()) ? v.trim() : null;
  };
  return pick(showProfile) ?? pick(brandProfile);
}

/** ffmpeg arguments for one render. Exported for tests. */
export function ffmpegArgs(o: {
  input: string; output: string; assPath: string; startS: number; durationS: number;
  width: number; height: number; hasVideo: boolean; background: string;
}): string[] {
  const { width: W, height: H } = o;
  const ass = `ass='${o.assPath.replace(/'/g, "\\'")}'`;
  const graph = o.hasVideo
    ? `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=24:2,eq=brightness=-0.18[bg];` +
      `[0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,fps=30,${ass}[v]`
    : `color=c=0x${o.background.replace('#', '')}:s=${W}x${H}:r=30:d=${o.durationS.toFixed(3)}[bg];` +
      `[0:a]showwaves=s=${W}x${Math.round(H / 4)}:mode=cline:scale=sqrt:rate=30:colors=white@0.9[wv];[bg][wv]overlay=0:(H-h)/2:shortest=1,${ass}[v]`;
  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', o.startS.toFixed(3), '-t', o.durationS.toFixed(3), '-i', o.input,
    '-filter_complex', graph, '-map', '[v]', '-map', '0:a:0',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-movflags', '+faststart', '-shortest',
    o.output,
  ];
}

export async function runRenderClip(job: JobRow, deps: RenderDeps): Promise<Record<string, unknown>> {
  const { db } = deps;
  const clipId = String(job.payload.clip_id ?? '');
  const clip = (await db.from('clips').select('*').eq('id', clipId).maybeSingle()).data as ClipRow | null;
  if (!clip) throw new PermanentError('Clip not found');
  if (clip.org_id !== job.org_id) throw new PermanentError('Clip belongs to another organisation');
  if (Number(job.payload.revision) !== clip.revision) {
    // Edited after this render was requested; the newer request renders the newer revision.
    return { skipped: 'stale revision', revision: clip.revision };
  }
  const src = await getSource(db, clip.source_id);
  if (!src.storage_path) throw new PermanentError('The source recording is missing');

  await db.from('clips').update({ status: 'rendering', updated_at: new Date().toISOString() }).eq('id', clip.id);
  const work = await mkdtemp(join(tmpdir(), 'orbit-clip-'));
  try {
    await jobProgress(db, job.id, 10, 'Fetching source recording');
    const dl = await db.storage.from('media').download(src.storage_path);
    if (dl.error || !dl.data) throw new Error(`download failed: ${dl.error?.message ?? 'no data'}`);
    const local = join(work, 'source');
    await writeFile(local, Buffer.from(await dl.data.arrayBuffer()));
    if (src.checksum_sha256 && (await sha256File(local)) !== src.checksum_sha256) {
      throw new PermanentError('Checksum mismatch: the stored recording differs from what was uploaded');
    }
    const p = await probe(local);

    // Times from the corrected transcript, with a short lead-in/out inside the recording.
    const segs = must(await db.from('transcript_segments').select('idx,start_ms,end_ms,text')
      .eq('source_id', src.id).gte('idx', clip.segment_start).lte('idx', clip.segment_end).order('idx'), 'load segments') as
      { idx: number; start_ms: number; end_ms: number; text: string }[];
    if (!segs.length || segs.some((s) => s.start_ms == null || s.end_ms == null)) throw new PermanentError('Clip segments have no times');
    const sourceMs = Math.round(p.durationSeconds * 1000);
    const startMs = Math.max(0, segs[0]!.start_ms - 250);
    const endMs = Math.min(sourceMs || Infinity, segs.at(-1)!.end_ms + 400);
    const durationMs = endMs - startMs;
    if (durationMs <= 0) throw new PermanentError('Clip range is outside the recording');

    const cues = buildCues(segs, clip.caption_text, startMs, endMs);
    const { width, height } = frameSize(clip.aspect_ratio);

    const [{ data: show }, { data: brand }] = await Promise.all([
      db.from('shows').select('name,current_profile_version_id').eq('id', clip.show_id).maybeSingle(),
      db.from('brands').select('name,current_profile_version_id').eq('id', clip.brand_id).maybeSingle(),
    ]);
    const prof = async (id: string | null | undefined) =>
      id ? ((await db.from('show_profile_versions').select('profile').eq('id', id).maybeSingle()).data?.profile ?? null) : null;
    const bprof = async (id: string | null | undefined) =>
      id ? ((await db.from('brand_profile_versions').select('profile').eq('id', id).maybeSingle()).data?.profile ?? null) : null;
    const colour = brandColour(await prof(show?.current_profile_version_id), await bprof(brand?.current_profile_version_id)) ?? '#1d3557';

    const assPath = join(work, 'captions.ass');
    await writeFile(assPath, toAss(cues, {
      width, height, durationMs, headline: clip.headline, brandColour: colour,
      burnCaptions: clip.caption_mode === 'burned', label: [show?.name, brand?.name].filter(Boolean).join(' · '), backgroundIsBrand: !p.hasVideo,
    }));

    await jobProgress(db, job.id, 35, 'Checking audio for music or non-speech');
    const sil = await run('ffmpeg', ['-hide_banner', '-nostats', '-ss', (startMs / 1000).toFixed(3), '-t', (durationMs / 1000).toFixed(3),
      '-i', local, '-vn', '-af', 'silencedetect=n=-35dB:d=0.4', '-f', 'null', '-']);
    const speech = segs.map((s) => ({ start_ms: s.start_ms - startMs, end_ms: s.end_ms - startMs }));
    const musicRanges = nonSpeechRanges(speech, parseSilences(sil.stderr, durationMs), durationMs);

    await jobProgress(db, job.id, 50, 'Rendering');
    const out = join(work, 'clip.mp4');
    await run('ffmpeg', ffmpegArgs({
      input: local, output: out, assPath, startS: startMs / 1000, durationS: durationMs / 1000,
      width, height, hasVideo: p.hasVideo, background: colour,
    }));
    const outProbe = await probe(out);
    if (!outProbe.hasVideo || !outProbe.hasAudio) throw new Error('Rendered file is missing video or audio');

    await jobProgress(db, job.id, 85, 'Saving files');
    const base = `${src.org_id}/${src.id}/clips/${clip.id}/r${clip.revision}`;
    const up = async (path: string, body: Buffer, type: string) => {
      const r = await db.storage.from('media').upload(path, body, { contentType: type, upsert: true });
      if (r.error) throw new Error(`upload ${path}: ${r.error.message}`);
      return path;
    };
    const videoPath = await up(`${base}.mp4`, await readFile(out), 'video/mp4');
    const srtPath = await up(`${base}.srt`, Buffer.from(toSrt(cues)), 'application/x-subrip');
    const vttPath = await up(`${base}.vtt`, Buffer.from(toVtt(cues)), 'text/vtt');
    const checksum = await sha256File(out);

    // Only land the result if nobody edited the clip while it rendered.
    const upd = await db.from('clips').update({
      status: 'rendered', render_error: null, video_path: videoPath, srt_path: srtPath, vtt_path: vttPath,
      video_checksum: checksum, rendered_revision: clip.revision, duration_ms: Math.round(outProbe.durationSeconds * 1000),
      music_flag: musicRanges.length > 0, music_ranges: musicRanges, updated_at: new Date().toISOString(),
    }).eq('id', clip.id).eq('revision', clip.revision).select('id');
    await audit(db, src.org_id, 'clip.rendered', 'clip', clip.id, {
      revision: clip.revision, renderer: RENDERER_VERSION, checksum, music_flag: musicRanges.length > 0,
    });
    return { clip: clip.id, revision: clip.revision, video: videoPath, landed: (upd.data ?? []).length > 0, music_ranges: musicRanges.length };
  } catch (e) {
    const permanent = e instanceof PermanentError;
    const final = permanent || job.attempts >= job.max_attempts;
    await db.from('clips').update({ status: final ? 'failed' : 'queued', render_error: (e as Error).message.slice(0, 500),
      updated_at: new Date().toISOString() }).eq('id', clip.id);
    throw e;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
