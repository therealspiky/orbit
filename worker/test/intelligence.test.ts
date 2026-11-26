import { describe, expect, it } from 'vitest';
import { cleanAnalysis, quoteInRange } from '../src/jobs/analyse.js';
import { canCiteAcross, suggestDueDate } from '../src/jobs/intelligence.js';
import { parsePublished, runWebResearch, toFinding } from '../src/jobs/webResearch.js';
import type { Segment } from '../src/types.js';

const seg = (idx: number, text: string, speaker: string | null = 'SPEAKER_2'): Segment =>
  ({ idx, start_ms: idx * 1000, end_ms: idx * 1000 + 900, speaker, text, confidence: null, is_uncertain: false });
const segments = [seg(0, 'Madam, the road flooded again.', 'SPEAKER_1'), seg(1, 'We will fix the flooded stretch of Asafo Road by Friday.'), seg(2, 'You can hold me to it.')];

describe('promise candidates', () => {
  it('keep only commitments quoted verbatim from the cited passage (G1)', () => {
    const a = cleanAnalysis({
      summary: '', themes: [], claims: [], questions_raised: [], usable_moments: [], sensitivities: [],
      commitments: [
        { quote: 'We will fix the flooded stretch of Asafo Road by Friday', speaker: 'SPEAKER_2', summary: 'MCE: fix road', due_phrase: 'by Friday', segment_start: 1, segment_end: 1 },
        { quote: 'We will rebuild every road in the district', speaker: 'SPEAKER_2', summary: 'invented', due_phrase: null, segment_start: 1, segment_end: 2 },
        { quote: 'You can hold me to it.', speaker: 'SPEAKER_9', summary: 'x', due_phrase: null, segment_start: 2, segment_end: 2 },
        { quote: 'fix', speaker: null, summary: 'out of range', due_phrase: null, segment_start: 2, segment_end: 7 },
      ],
      follow_up_questions: [{ question: 'Who pays if Friday passes?', why: 'No penalty discussed', segment_start: 1, segment_end: 2 }],
    }, segments);
    expect(a.commitments!.map((c) => c.quote)).toEqual(['We will fix the flooded stretch of Asafo Road by Friday', 'You can hold me to it.']);
    expect(a.commitments![1]!.speaker).toBeNull();
    expect(a.follow_up_questions).toHaveLength(1);
  });
  it('matches quotes despite punctuation and case', () => {
    expect(quoteInRange('we will fix the FLOODED stretch', segments, 1, 1)).toBe(true);
    expect(quoteInRange('we will fix it', segments, 1, 1)).toBe(false);
  });
});

describe('suggested due dates (never authoritative)', () => {
  const thu = new Date('2026-11-26T00:00:00Z'); // a Thursday
  it('parses spoken weekdays and relative words', () => {
    expect(suggestDueDate('by Friday', thu)).toBe('2026-11-27');
    expect(suggestDueDate('by Thursday', thu)).toBe('2026-12-03');
    expect(suggestDueDate('by next Friday', thu)).toBe('2026-12-04');
    expect(suggestDueDate('tomorrow', thu)).toBe('2026-11-27');
    expect(suggestDueDate('by the end of the month', thu)).toBe('2026-11-30');
    expect(suggestDueDate('by 15th December', thu)).toBe('2026-12-15');
    expect(suggestDueDate('by March 3', thu)).toBe('2027-03-03');
  });
  it('returns null for anything vague', () => {
    expect(suggestDueDate('soon', thu)).toBeNull();
    expect(suggestDueDate(null, thu)).toBeNull();
    expect(suggestDueDate('very soon, God willing', thu)).toBeNull();
  });
});

describe('archive citations across shows', () => {
  const current = { brand_id: 'b1', show_id: 's1' };
  it('follow the prior source sharing scope', () => {
    expect(canCiteAcross({ share_scope: 'organisation', brand_id: 'b2', show_id: 's9' }, current)).toBe(true);
    expect(canCiteAcross({ share_scope: 'brand', brand_id: 'b1', show_id: 's2' }, current)).toBe(true);
    expect(canCiteAcross({ share_scope: 'brand', brand_id: 'b2', show_id: 's2' }, current)).toBe(false);
    expect(canCiteAcross({ share_scope: 'show', brand_id: 'b1', show_id: 's2' }, current)).toBe(false);
    expect(canCiteAcross({ share_scope: 'show', brand_id: 'b1', show_id: 's1' }, current)).toBe(true);
  });
});

describe('web findings', () => {
  it('keep publisher, title and short excerpt; unknown dates stay unknown', () => {
    const f = toFinding({ url: 'https://www.example.org/a', title: '<b>Delay</b> announced', excerpt: 'x '.repeat(400), published: 'last week', raw: {} }, 'o', 'q')!;
    expect(f.publisher).toBe('example.org');
    expect(f.title).toBe('Delay announced');
    expect(f.excerpt.length).toBeLessThanOrEqual(580);
    expect(f.published_on).toBeNull();
    expect(parsePublished('2026-11-20T10:00:00Z')).toBe('2026-11-20');
    expect(parsePublished('2099-01-01')).toBeNull();
  });
  it('drops non-web links and empty results', () => {
    expect(toFinding({ url: 'javascript:alert(1)', title: 't', excerpt: 'e', published: null, raw: {} }, 'o', 'q')).toBeNull();
    expect(toFinding({ url: 'https://a.b', title: '', excerpt: 'e', published: null, raw: {} }, 'o', 'q')).toBeNull();
  });
  it('fails clearly when no search provider is configured', async () => {
    const db: any = {
      from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { id: 'q', org_id: 'o', query_text: 'x' }, error: null }) }) }),
                     update: () => ({ eq: async () => ({ error: null }) }) }),
    };
    await expect(runWebResearch({ id: 'j', org_id: 'o', kind: 'web_research', payload: { query_id: 'q' }, attempts: 1, max_attempts: 3, created_by: null },
      { db, cfg: {} as any, provider: null })).rejects.toThrow(/not configured/);
  });
});
