/**
 * Caption timing and subtitle formats for rendered clips. Pure functions, unit-tested.
 *
 * Times always come from transcript segments. When the on-screen caption text still matches
 * the corrected transcript, each segment's words keep that segment's own time window. When an
 * editor has rewritten the captions, the edited words are spread across the clip by word count
 * and the clip carries caption_differs = true for review.
 */
export interface TimedSegment { start_ms: number; end_ms: number; text: string }
export interface Cue { start_ms: number; end_ms: number; text: string }

export function normaliseText(s: string): string {
  return s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
}

/** Splits words into caption lines of at most maxChars, at most maxLines per cue. */
export function chunkWords(words: string[], maxChars = 32, maxLines = 2): string[] {
  const cues: string[] = [];
  let lines: string[] = [];
  let line = '';
  const flushLine = () => { if (line) { lines.push(line); line = ''; } };
  const flushCue = () => { flushLine(); if (lines.length) { cues.push(lines.join('\n')); lines = []; } };
  for (const w of words) {
    if (line && (line.length + 1 + w.length) > maxChars) {
      flushLine();
      if (lines.length >= maxLines) flushCue();
    }
    line = line ? `${line} ${w}` : w;
    // End a cue at sentence ends so captions breathe with the speech.
    if (/[.?!]$/.test(w) && (lines.length + 1) >= 1 && line.length > maxChars / 2) flushCue();
  }
  flushCue();
  return cues;
}

function spread(text: string, start: number, end: number): Cue[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length || end <= start) return [];
  const chunks = chunkWords(words);
  const total = words.length;
  const out: Cue[] = [];
  let used = 0;
  for (const c of chunks) {
    const n = c.split(/\s+/).length;
    const s = start + Math.round(((end - start) * used) / total);
    used += n;
    const e = start + Math.round(((end - start) * used) / total);
    out.push({ start_ms: s, end_ms: Math.max(e, s + 300), text: c });
  }
  return out;
}

/**
 * Cues relative to the clip start (0 = first frame).
 * @param segments segments in the clip range, with absolute source times
 * @param captionText the clip's caption text (may be edited)
 */
export function buildCues(segments: TimedSegment[], captionText: string, clipStartMs: number, clipEndMs: number): Cue[] {
  const transcript = segments.map((s) => s.text).join(' ');
  const rel = (ms: number) => Math.max(0, Math.min(clipEndMs, ms) - clipStartMs);
  if (normaliseText(transcript) === normaliseText(captionText)) {
    return segments.flatMap((s) => spread(s.text, rel(s.start_ms), rel(s.end_ms)));
  }
  return spread(captionText, rel(segments[0]?.start_ms ?? clipStartMs), rel(segments.at(-1)?.end_ms ?? clipEndMs));
}

function pad(n: number, w = 2) { return String(n).padStart(w, '0'); }
function clock(ms: number, sep: string) {
  const h = Math.floor(ms / 3600000); const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000); const r = ms % 1000;
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(r, 3)}`;
}

export function toSrt(cues: Cue[]): string {
  return cues.map((c, i) => `${i + 1}\n${clock(c.start_ms, ',')} --> ${clock(c.end_ms, ',')}\n${c.text}\n`).join('\n');
}

export function toVtt(cues: Cue[]): string {
  return `WEBVTT\n\n${cues.map((c) => `${clock(c.start_ms, '.')} --> ${clock(c.end_ms, '.')}\n${c.text}\n`).join('\n')}`;
}

/** #RRGGBB to ASS &HAABBGGRR. Falls back to Orb.IT navy for anything unparseable. */
export function assColour(hex: string | undefined | null, alpha = 0): string {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex ?? '').trim());
  const h = m ? m[1]! : '1d3557';
  const r = h.slice(0, 2); const g = h.slice(2, 4); const b = h.slice(4, 6);
  return `&H${alpha.toString(16).padStart(2, "0")}${b}${g}${r}`.toUpperCase();
}

function assTime(ms: number) {
  const cs = Math.round(ms / 10);
  const h = Math.floor(cs / 360000); const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100); const r = cs % 100;
  return `${h}:${pad(m)}:${pad(s)}.${pad(r)}`;
}

function assEscape(t: string) {
  return t.replace(/\\/g, '\\\\').replace(/[{}]/g, '').replace(/\n/g, '\\N');
}

export interface AssOptions {
  width: number; height: number; durationMs: number;
  headline: string; brandColour?: string | null; burnCaptions: boolean; label?: string;
  /** The frame background is already the brand colour (audiogram): put the headline on a dark band. */
  backgroundIsBrand?: boolean;
}

/** ASS script with a headline band, optional burned-in captions, and a small credit label. */
export function toAss(cues: Cue[], o: AssOptions): string {
  const vertical = o.height > o.width;
  const capSize = Math.round(o.width * (vertical ? 0.058 : 0.034));
  const headSize = Math.round(o.width * (vertical ? 0.062 : 0.036));
  const labelSize = Math.round(capSize * 0.5);
  const brand = o.backgroundIsBrand ? '&H64000000' : assColour(o.brandColour);
  const lines = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${o.width}`, `PlayResY: ${o.height}`, 'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Caption,Inter,${capSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,1,0,0,0,100,100,0,0,3,${Math.round(capSize * 0.22)},0,2,${Math.round(o.width * 0.07)},${Math.round(o.width * 0.07)},${Math.round(o.height * (vertical ? 0.2 : 0.09))},1`,
    `Style: Headline,Inter,${headSize},&H00FFFFFF,&H00FFFFFF,${brand},${brand},1,0,0,0,100,100,0,0,3,${Math.round(headSize * 0.35)},0,8,${Math.round(o.width * 0.06)},${Math.round(o.width * 0.06)},${Math.round(o.height * (vertical ? 0.08 : 0.05))},1`,
    `Style: Label,Inter,${labelSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,3,${Math.round(labelSize * 0.3)},0,3,${Math.round(o.width * 0.04)},${Math.round(o.width * 0.04)},${Math.round(o.height * 0.03)},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const end = assTime(o.durationMs);
  if (o.headline.trim()) lines.push(`Dialogue: 0,0:00:00.00,${end},Headline,,0,0,0,,${assEscape(o.headline.trim())}`);
  if (o.label) lines.push(`Dialogue: 0,0:00:00.00,${end},Label,,0,0,0,,${assEscape(o.label)}`);
  if (o.burnCaptions) {
    for (const c of cues) lines.push(`Dialogue: 1,${assTime(c.start_ms)},${assTime(c.end_ms)},Caption,,0,0,0,,${assEscape(c.text)}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Stretches inside the clip with sound but no transcribed speech, from silencedetect output and
 * segment times (both relative to the clip). Long ones are flagged as possible music for review.
 */
export function nonSpeechRanges(
  speech: { start_ms: number; end_ms: number }[], silences: { start_ms: number; end_ms: number }[],
  durationMs: number, minMs = 2500,
): { start_ms: number; end_ms: number }[] {
  const covered = [...speech, ...silences].map((r) => ({ s: Math.max(0, r.start_ms), e: Math.min(durationMs, r.end_ms) }))
    .filter((r) => r.e > r.s).sort((a, b) => a.s - b.s);
  const gaps: { start_ms: number; end_ms: number }[] = [];
  let at = 0;
  for (const r of covered) {
    if (r.s - at >= minMs) gaps.push({ start_ms: at, end_ms: r.s });
    at = Math.max(at, r.e);
  }
  if (durationMs - at >= minMs) gaps.push({ start_ms: at, end_ms: durationMs });
  return gaps;
}

export function parseSilences(stderr: string, durationMs: number): { start_ms: number; end_ms: number }[] {
  const out: { start_ms: number; end_ms: number }[] = [];
  let start: number | null = null;
  for (const line of stderr.split('\n')) {
    const s = /silence_start: (-?[\d.]+)/.exec(line);
    if (s) start = Math.max(0, Math.round(Number(s[1]) * 1000));
    const e = /silence_end: ([\d.]+)/.exec(line);
    if (e && start !== null) { out.push({ start_ms: start, end_ms: Math.round(Number(e[1]) * 1000) }); start = null; }
  }
  if (start !== null) out.push({ start_ms: start, end_ms: durationMs });
  return out;
}
