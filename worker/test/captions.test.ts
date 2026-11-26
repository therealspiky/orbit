import { describe, expect, it } from 'vitest';
import { assColour, buildCues, chunkWords, nonSpeechRanges, normaliseText, parseSilences, toAss, toSrt, toVtt } from '../src/lib/captions.js';
import { brandColour, ffmpegArgs, frameSize } from '../src/jobs/renderClip.js';

const segs = [
  { start_ms: 10_000, end_ms: 12_000, text: 'I want to be very clear.' },
  { start_ms: 12_000, end_ms: 16_000, text: 'We will fix the flooded stretch of Asafo Road by Friday.' },
];

describe('caption cues', () => {
  it('keeps each segment inside its own transcript time window', () => {
    const cues = buildCues(segs, 'I want to be very clear. We will fix the flooded stretch of Asafo Road by Friday.', 9_750, 16_400);
    expect(cues[0]!.start_ms).toBe(250);
    const second = cues.filter((c) => c.text.includes('flooded'));
    expect(second[0]!.start_ms).toBeGreaterThanOrEqual(2_250);
    expect(cues.at(-1)!.end_ms).toBeLessThanOrEqual(6_650);
    expect(cues.map((c) => c.text.replace(/\n/g, ' ')).join(' ')).toBe('I want to be very clear. We will fix the flooded stretch of Asafo Road by Friday.');
  });

  it('spreads edited captions across the spoken range', () => {
    const cues = buildCues(segs, 'We will fix Asafo Road by Friday.', 10_000, 16_000);
    expect(cues.map((c) => c.text.replace(/\n/g, ' ')).join(' ')).toBe('We will fix Asafo Road by Friday.');
    expect(cues[0]!.start_ms).toBe(0);
    expect(cues.at(-1)!.end_ms).toBe(6_000);
  });

  it('treats typography and spacing differences as the same text', () => {
    expect(normaliseText('It’s  “fine”')).toBe(normaliseText("it's \"fine\""));
  });

  it('wraps to at most two lines of 32 characters', () => {
    for (const c of chunkWords('one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen'.split(' '))) {
      const lines = c.split('\n');
      expect(lines.length).toBeLessThanOrEqual(2);
      for (const l of lines) expect(l.length).toBeLessThanOrEqual(32);
    }
  });
});

describe('subtitle formats', () => {
  const cues = [{ start_ms: 1_500, end_ms: 3_250, text: 'Hello\nthere' }];
  it('writes SRT and VTT', () => {
    expect(toSrt(cues)).toBe('1\n00:00:01,500 --> 00:00:03,250\nHello\nthere\n');
    expect(toVtt(cues)).toBe('WEBVTT\n\n00:00:01.500 --> 00:00:03.250\nHello\nthere\n');
  });
  it('writes ASS with headline, label and escaped captions', () => {
    const ass = toAss([{ start_ms: 0, end_ms: 1_000, text: 'a {b}\nc' }], { width: 1080, height: 1920, durationMs: 2_000, headline: 'Hook', burnCaptions: true, label: 'Show · Brand' });
    expect(ass).toContain('PlayResX: 1080');
    expect(ass).toContain('Headline,,0,0,0,,Hook');
    expect(ass).toContain('Caption,,0,0,0,,a b\\Nc');
    expect(toAss([], { width: 1080, height: 1920, durationMs: 1, headline: '', burnCaptions: false })).not.toContain('Caption,,');
  });
  it('converts colours and falls back on bad input', () => {
    expect(assColour('#e63946')).toBe('&H004639E6');
    expect(assColour('nope')).toBe('&H0057351D');
  });
});

describe('music / non-speech flag', () => {
  it('flags long stretches with sound but no speech', () => {
    const silences = parseSilences('[silencedetect] silence_start: 2.0\n[silencedetect] silence_end: 2.5 | silence_duration: 0.5', 20_000);
    expect(silences).toEqual([{ start_ms: 2_000, end_ms: 2_500 }]);
    const r = nonSpeechRanges([{ start_ms: 0, end_ms: 2_000 }, { start_ms: 12_000, end_ms: 20_000 }], silences, 20_000);
    expect(r).toEqual([{ start_ms: 2_500, end_ms: 12_000 }]);
  });
  it('does not flag short pauses or silence', () => {
    expect(nonSpeechRanges([{ start_ms: 0, end_ms: 5_000 }, { start_ms: 6_000, end_ms: 9_000 }], [], 9_000)).toEqual([]);
    expect(nonSpeechRanges([{ start_ms: 0, end_ms: 1_000 }], [{ start_ms: 1_000, end_ms: 9_000 }], 9_000)).toEqual([]);
  });
});

describe('render settings', () => {
  it('uses vertical 1080x1920 by default and the brand colour from profiles', () => {
    expect(frameSize('9:16')).toEqual({ width: 1080, height: 1920 });
    expect(brandColour({ brand_kit: { primary_colour: '#112233' } }, null)).toBe('#112233');
    expect(brandColour({}, { brand_kit: { primary_colour: 'red' } })).toBeNull();
  });
  it('builds an H.264/AAC command with burned subtitles', () => {
    const a = ffmpegArgs({ input: 'in', output: 'out.mp4', assPath: '/tmp/x.ass', startS: 1, durationS: 2, width: 1080, height: 1920, hasVideo: false, background: '#112233' });
    expect(a).toContain('libx264');
    expect(a).toContain('aac');
    expect(a.join(' ')).toContain("ass='/tmp/x.ass'");
    expect(a.join(' ')).toContain('color=c=0x112233');
  });
});
