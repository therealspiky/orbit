/**
 * End-to-end demo of the day-one loop against a LOCAL Supabase stack (never production):
 * org setup → upload → real local transcription → correction → analysis → cross-brand briefs (3 shows,
 * 3 brands) → evidence checks → review → owner approval → rendered captioned clips → export package.
 *
 * Everything runs through the real worker jobs, RPCs and RLS as a signed-in user, EXCEPT the language model:
 * when ANTHROPIC_API_KEY is not set, a scripted stand-in fills the analysis and brief tool calls from the real
 * transcript (it copies quotes verbatim from the segments). The worker's validation still checks every quote.
 * With a key set, the real model is used instead.
 *
 *   SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_SERVICE_ROLE_KEY=... SUPABASE_ANON_KEY=... \
 *   TRANSCRIBE_PROVIDER=local WHISPER_MODEL_DIR=... npx tsx scripts/demo-run.ts path/to/show.mp4
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { loadConfig } from '../src/config.js';
import { runAnalyse } from '../src/jobs/analyse.js';
import { runGenerateBriefs } from '../src/jobs/generateBriefs.js';
import { runRenderClip } from '../src/jobs/renderClip.js';
import { runTranscribe } from '../src/jobs/transcribe.js';
import { makeDb } from '../src/lib/db.js';
import { AnthropicLlm, type LlmClient, type StructuredCall, type StructuredResult } from '../src/lib/llm.js';
import { INSTALLED_MODULES } from '../src/modules/index.js';
import { InstanceModules } from '../src/modules/state.js';
import { PermanentError, type JobRow } from '../src/types.js';

const file = process.argv[2] ?? '';
if (!file) throw new Error('Usage: demo-run.ts <recording>');
const cfg = loadConfig();
if (!/127\.0\.0\.1|localhost/.test(cfg.supabaseUrl)) throw new Error('demo-run only runs against a local Supabase stack');
const admin = makeDb(cfg);
const anon = process.env.SUPABASE_ANON_KEY!;
const log = (m: string, x?: unknown) => console.log(`• ${m}${x === undefined ? '' : ` ${typeof x === 'string' ? x : JSON.stringify(x)}`}`);
const ok = <T>(r: { data: T; error: { message: string } | null } | { data: unknown; error: { message: string } }, what: string): T => { if (r.error) throw new Error(`${what}: ${r.error.message}`); return r.data as T; };

// ---------------------------------------------------------------------------
// Scripted stand-in for the model (only when no key). Quotes are copied from real segments.
// ---------------------------------------------------------------------------
type Seg = { idx: number; text: string; speaker: string | null };
let segs: Seg[] = [];
let currentSource = '';
const find = (re: RegExp): Seg => segs.find((s) => re.test(s.text)) ?? segs[0]!;
const quoteOf = (s: Seg, re?: RegExp) => { const m = re ? s.text.match(re) : null; return (m ? m[0] : s.text).trim(); };

class ScriptedLlm implements LlmClient {
  async structured<T>(call: StructuredCall<T>): Promise<StructuredResult<T>> {
    segs = ok(await admin.from('transcript_segments').select('idx,text,speaker').eq('source_id', currentSource).order('idx'), 'segs') as Seg[];
    const promise = find(/we will fix/i), cheat = find(/cheating is normal/i), pretend = find(/pretend to hate/i), march = find(/in march/i);
    let value: unknown;
    if (call.toolName === 'record_analysis') {
      value = {
        summary: 'A breakfast-show interview with the Municipal Chief Executive about repeated flooding on a city road, followed by a discussion of a relationship-show panel claim about cheating.',
        themes: [
          { theme: 'Road flooding and the assembly response', note: 'Traders and schoolchildren affected; a dated commitment is made.', segment_start: promise.idx - 2, segment_end: march.idx + 1 },
          { theme: 'Cheating and why people stay', note: 'The guest disputes a viral panel claim.', segment_start: cheat.idx - 1, segment_end: pretend.idx + 3 },
        ],
        claims: [{ claim: 'The contractor is on site and drain money has been released.', speaker: promise.speaker, claim_type: 'factual_assertion', needs_verification: true, segment_start: promise.idx + 1, segment_end: promise.idx + 1 }],
        questions_raised: ['Was the road fixed by the date given?'],
        usable_moments: [{ why: 'Dated on-air commitment', segment_start: promise.idx, segment_end: promise.idx + 1 }],
        sensitivities: [],
        commitments: [{ quote: quoteOf(promise, /we will fix[^.]*/i), speaker: promise.speaker, summary: 'The MCE committed to fixing the flooded stretch by Friday.', due_phrase: 'by Friday', segment_start: promise.idx, segment_end: promise.idx }],
        follow_up_questions: [{ question: 'Was the Friday deadline met, and if not, why?', why: 'A dated commitment was made on air.', segment_start: promise.idx, segment_end: promise.idx + 2 }],
      };
    } else if (call.toolName === 'record_brief') {
      const dest = `${call.system}\n${call.user}`.match(/DESTINATION: ([^(\n]+)/)?.[1] ?? "";
      const debate = /Evening Debate/.test(dest), lifestyle = /After Hours Lifestyle/.test(dest);
      const ev = debate || !lifestyle
        ? [{ s: promise, re: /we will fix[^.]*/i, why: 'The dated commitment this treatment follows up.' }, { s: march, why: 'Earlier missed deadline raised by the presenter.' }]
        : [{ s: cheat, why: 'The viral claim the guest responds to.' }, { s: pretend, why: "The guest's own position." }];
      const title = debate ? 'Did the Asafo Road get fixed? Holding the assembly to Friday'
        : lifestyle ? 'Why people stay: love, fear or money?' : 'Flooded road, Friday deadline: traders call in';
      value = {
        title, premise: debate ? 'Was an on-air deadline for a public works fix realistic, and what happens when it slips?' : lifestyle ? 'Why do people stay after cheating, and is the "if he provides" view common?' : 'How the flooding affects traders, and what listeners expect by Friday.',
        why_now: 'Raised on Coast 101 this morning.', audience_value: 'Listeners get the facts and a voice.',
        destination_fit: { summary: 'Fits the show remit.', profile_fields: [{ field: 'identity.remit', how_it_fits: 'Matches the show remit.' }] },
        new_contribution: debate ? 'Puts the commitment next to the earlier missed deadline and invites a second view.' : 'Adds caller perspectives.',
        recommendation: 'proceed', recommendation_reason: 'Grounded in verbatim source passages.',
        evidence: ev.map((e, i) => ({ ref: `E${i + 1}`, segment_start: e.s.idx, segment_end: e.s.idx, quote: quoteOf(e.s, e.re), attribution: e.s.speaker, kind: 'source_statement', relevance: e.why })),
        uncertainties: ['Whether the contractor is actually on site is not yet verified.'], contradictory_evidence: [],
        treatment: { format: debate ? 'Panel debate' : 'Phone-in', duration_minutes: 20, lines_of_inquiry: [{ question: 'What was promised, and by when?', evidence_refs: ['E1'] }],
          presenter_opening: 'This morning on Coast 101 a deadline was set.', interview_questions: ['What has changed since?'], takeaway: 'Listeners know what to watch for.' },
        rundown: [{ title: 'Open', purpose: 'Set up', start_minute: 0, duration_minutes: 3, is_break: false, owner_role: 'presenter', prompts: 'Play the clip', evidence_refs: ['E1'], cues: 'Clip E1', fallback: 'Read the quote' }],
        guests: [{ perspective_needed: 'Independent engineer', why_needed: 'Assess the timeline', suggested_profile: 'A civil engineer with drainage experience', credentials_to_verify: ['Professional registration'], conflicts_to_check: ['Contracts with the assembly'] }],
        production_tasks: [{ title: 'Ask the assembly for the contract timeline', detail: 'Request written confirmation.', owner_role: 'producer', blocking: true }],
        social_package: [{ asset_type: 'audiogram', platform: 'TikTok', format: '9:16', hook: debate ? '"By Friday." Will it happen?' : 'Love, fear or money?', caption_draft: 'Listen back.',
          clip_candidate: { segment_start: ev[0]!.s.idx, segment_end: Math.min(ev[0]!.s.idx + 1, segs.length - 1), rationale: 'Self-contained moment.' }, thumbnail_direction: null }],
        review_flags: [{ check: 'fairness', concern: 'Give the assembly a right of reply.', severity: 'medium' }],
        continuation: { success_criteria: ['Assembly responds'], post_show_questions: ['Was the road fixed?'], follow_up_ideas: [{ title: 'Friday check', advance: 'Return to the site' }] },
        unresolved: [],
      };
    } else {
      throw new PermanentError(`The scripted stand-in does not cover "${call.toolName}" (set ANTHROPIC_API_KEY to run it for real)`);
    }
    return { value: call.schema.parse(value), model: 'scripted-stand-in', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  }
}

const llm: LlmClient = cfg.anthropicKey ? new AnthropicLlm(cfg.anthropicKey, cfg.anthropicWorkspaceId) : new ScriptedLlm();
const modules = new InstanceModules(admin, cfg, INSTALLED_MODULES);

/** Drain the job queue the way the worker loop does. */
async function drain(label: string) {
  await modules.refresh(true);
  for (;;) {
    const job = ok(await admin.rpc('claim_job', { p_worker: 'demo-run' }), 'claim') as JobRow | null;
    if (!job?.id) return;
    const t = Date.now();
    try {
      let result: Record<string, unknown>;
      switch (job.kind) {
        case 'transcribe': result = await runTranscribe(job, { db: admin, cfg, media: modules.installed('recording_transcription')?.mediaTranscriber?.(cfg) ?? null }); break;
        case 'analyse': result = await runAnalyse(job, { db: admin, cfg, llm, modules }); break;
        case 'generate_briefs': result = await runGenerateBriefs(job, { db: admin, cfg, llm, modules }); break;
        case 'render_clip': result = await runRenderClip(job, { db: admin, cfg }); break;
        default: throw new PermanentError(`skipped in demo (${job.kind})`);
      }
      await admin.from('jobs').update({ status: 'succeeded', progress: 100, message: 'Done', result, locked_by: null }).eq('id', job.id);
      log(`${label}: ${job.kind} done in ${((Date.now() - t) / 1000).toFixed(1)}s`, result);
    } catch (e) {
      await admin.from('jobs').update({ status: 'failed', error: (e as Error).message, locked_by: null }).eq('id', job.id);
      log(`${label}: ${job.kind} not run: ${(e as Error).message}`);
    }
  }
}

async function main() {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
  const email = `demo-${stamp}@orbit.local`, password = `demo-${stamp}-pw`;
  ok(await admin.auth.admin.createUser({ email, password, email_confirm: true }), 'create user');
  const sb = createClient(cfg.supabaseUrl, anon, { auth: { persistSession: false } });
  ok(await sb.auth.signInWithPassword({ email, password }), 'sign in');
  log('signed in as', email);

  // Organisation → brands → shows (with approved profiles) → season → episode
  const org = ok(await sb.rpc('create_organisation', { p_name: `Coast Media Group (demo ${stamp})`, p_type: 'media_group' }), 'org') as string;
  const brand = async (name: string) => (ok(await sb.from('brands').insert({ org_id: org, name }).select('id').single(), 'brand') as { id: string }).id;
  const [coast, harbour, pulse] = [await brand('Coast 101'), await brand('Harbour TV'), await brand('Pulse FM')];
  const show = async (brand_id: string, name: string, category: string, remit: string, tone: string) => {
    const id = (ok(await sb.from('shows').insert({ org_id: org, brand_id, name, editorial_category: category }).select('id').single(), 'show') as { id: string }).id;
    const v = ok(await sb.rpc('create_profile_draft', { p_show: id, p_profile: {
      identity: { remit, audience: 'Adults in Greater Accra' }, voice: { tone, episode_length_minutes: 60 }, language: { primary: 'en' } } }), 'profile') as string;
    ok(await sb.rpc('approve_profile', { p_version: v }), 'approve profile');
    return id;
  };
  const breakfast = await show(coast, 'Harbour City Breakfast', 'current_affairs', 'Morning news and accountability.', 'Brisk');
  const debate = await show(harbour, 'Evening Debate', 'current_affairs', 'Two-sided debate on public affairs.', 'Firm and fair');
  const drive = await show(pulse, 'Pulse Drive', 'entertainment', 'Phone-in and street voices on the day\'s talk.', 'High-energy');
  const lifestyle = await show(pulse, 'After Hours Lifestyle', 'lifestyle', 'Relationships and modern life.', 'Warm and candid');
  ok(await sb.from('seasons').insert({ org_id: org, brand_id: coast, show_id: breakfast, name: 'Season 1', status: 'active' }), 'season');
  const episode = (ok(await sb.from('episodes').insert({ org_id: org, brand_id: coast, show_id: breakfast, title: 'Breakfast, 26 Nov', air_date: '2026-11-26' }).select('id').single(), 'episode') as { id: string }).id;
  const people = ok(await sb.from('people').insert([
    { org_id: org, display_name: 'Kojo Asante', kind: 'staff', title: 'Presenter' },
    { org_id: org, display_name: 'Esi Darko', kind: 'public_figure', title: 'Municipal Chief Executive' },
  ]).select('id,display_name'), 'people') as { id: string; display_name: string }[];
  ok(await sb.from('episode_credits').insert({ org_id: org, episode_id: episode, person_id: people[0]!.id, credit_role: 'presenter' }), 'credit');
  log('organisation set up: 3 brands, 4 shows with approved profiles, a season, an episode, 2 people');

  // Upload → transcribe (real) → analyse
  const bytes = readFileSync(file);
  const checksum = createHash('sha256').update(bytes).digest('hex');
  const src = ok(await sb.from('sources').insert({ org_id: org, brand_id: coast, show_id: breakfast, episode_id: episode, kind: 'recording',
    title: 'Harbour City Breakfast, 26 Nov', language: 'en', share_scope: 'organisation', rights_status: 'owned' }).select('id').single(), 'source') as { id: string };
  const path = `${org}/${src.id}/${basename(file)}`;
  ok(await sb.storage.from('media').upload(path, bytes, { contentType: 'video/mp4' }), 'upload');
  ok(await sb.rpc('attach_source_upload', { p_source: src.id, p_path: path, p_checksum: checksum, p_size: bytes.length, p_mime: 'video/mp4' }), 'attach');
  ok(await sb.rpc('enqueue_job', { p_org: org, p_kind: 'transcribe', p_payload: { source_id: src.id }, p_idempotency_key: `transcribe:${src.id}` }), 'enqueue');
  log('uploaded', `${(bytes.length / 1e6).toFixed(1)} MB`);
  currentSource = src.id;
  await drain('ingest');
  segs = ok(await admin.from('transcript_segments').select('idx,text,speaker,start_ms').eq('source_id', src.id).order('idx'), 'segs') as Seg[];
  log(`transcript: ${segs.length} segments`);

  // Map the presenter label (if any) and correct a mis-heard place name
  for (const asafo of segs.filter((s) => /a saffo|asofo|reins/i.test(s.text))) {
    const seg = ok(await sb.from('transcript_segments').select('id,text').eq('source_id', src.id).eq('idx', asafo.idx).single(), 'seg') as { id: string; text: string };
    const fixed = seg.text.replace(/a saffo|asofo/gi, 'Asafo').replace(/\breins\b/g, 'rains');
    if (fixed !== seg.text) { ok(await sb.rpc('correct_segment', { p_segment: seg.id, p_text: fixed }), 'correct'); log('corrected passage', `${asafo.idx}: "${fixed.trim()}"`); }
  }
  segs = ok(await admin.from('transcript_segments').select('idx,text,speaker').eq('source_id', src.id).order('idx'), 'segs') as Seg[];

  // Cross-brand briefs: 3 brands, 3 destination shows
  ok(await sb.rpc('enqueue_job', { p_org: org, p_kind: 'generate_briefs', p_payload: { source_id: src.id, show_ids: [debate, drive, lifestyle], generation_group: randomUUID() }, p_idempotency_key: `generate:${src.id}:${stamp}` }), 'enqueue briefs');
  await drain('briefs');
  const briefs = ok(await sb.from('briefs').select('id,title,show_id,brand_id,status,current_version_id').eq('origin_source_id', src.id), 'briefs') as
    { id: string; title: string; show_id: string; status: string; current_version_id: string }[];
  log(`${briefs.length} briefs`, briefs.map((b) => b.title));

  // Pick the Evening Debate brief (current affairs: needs owner approval) and take it through review
  const b = briefs.find((x) => x.show_id === debate) ?? briefs[0];
  if (!b) throw new Error("No briefs were written");
  const ev = ok(await sb.from('evidence').select('id,ref_key,verification,quote').eq('brief_version_id', b.current_version_id), 'evidence') as { id: string; ref_key: string; verification: string; quote: string | null }[];
  log('evidence', ev.map((e) => `${e.ref_key} ${e.verification}: "${e.quote}"`));
  for (const e of ev) ok(await sb.rpc('verify_evidence', { p_evidence: e.id, p_state: 'verified' }), 'verify');
  const tasks = ok(await sb.from('research_tasks').select('id,blocking').eq('brief_id', b.id), 'tasks') as { id: string; blocking: boolean }[];
  for (const t of tasks) ok(await sb.from('research_tasks').update({ status: 'done' }).eq('id', t.id), 'task');
  ok(await sb.rpc('set_brief_status', { p_brief: b.id, p_status: 'producer_review' }), 'submit');
  for (const c of ['fact', 'fairness', 'privacy', 'rights', 'language']) ok(await sb.rpc('record_check', { p_brief: b.id, p_version: b.current_version_id, p_check: c, p_outcome: 'passed' }), `check ${c}`);

  // Clip from the brief's social package, rendered by the worker
  const ver = ok(await sb.from('brief_versions').select('content').eq('id', b.current_version_id).single(), 'version') as { content: any };
  const cand = ver.content.social_package?.[0]?.clip_candidate ?? { segment_start: 0, segment_end: 1 };
  const clip = ok(await sb.rpc('create_clip', { p_brief: b.id, p_segment_start: cand.segment_start, p_segment_end: cand.segment_end, p_aspect: '9:16', p_headline: '"By Friday." Will it happen?', p_social_index: 0, p_caption_mode: 'burned' }), 'clip') as string;
  ok(await sb.rpc('request_clip_render', { p_clip: clip }), 'render');
  const clip169 = ok(await sb.rpc('create_clip', { p_brief: b.id, p_segment_start: segs.findIndex((s) => /in march/i.test(s.text)), p_segment_end: segs.findIndex((s) => /honest answer/i.test(s.text)), p_aspect: '16:9', p_headline: 'The drains were due before the rains', p_social_index: null, p_caption_mode: 'burned' }), 'clip 16:9') as string;
  ok(await sb.rpc('request_clip_render', { p_clip: clip169 }), 'render');
  await drain('clips');
  const clips = ok(await sb.from('clips').select('id,status,aspect_ratio,video_path,duration_ms,render_error').eq('brief_id', b.id), 'clips') as { id: string; status: string; aspect_ratio: string; video_path: string | null; duration_ms: number | null; render_error: string | null }[];
  log('clips', clips.map((c) => `${c.aspect_ratio} ${c.status} ${c.duration_ms ?? ''}ms ${c.render_error ?? ''}`));
  for (const c of clips.filter((x) => x.video_path)) {
    const dl = await admin.storage.from('media').download(c.video_path!);
    if (dl.data) writeFileSync(`demo-clip-${c.aspect_ratio.replace(':', 'x')}.mp4`, Buffer.from(await dl.data.arrayBuffer()));
  }

  // Approve → export is blocked until the brand owner approves → owner approves → export package
  ok(await sb.rpc('approve_brief', { p_brief: b.id, p_version: b.current_version_id, p_reason: 'Checks passed' }), 'approve');
  const blocked = await sb.rpc('export_brief_package', { p_brief: b.id });
  log('export before owner approval', blocked.error?.message ?? 'NOT BLOCKED (unexpected)');
  ok(await sb.rpc('owner_approve_brief', { p_brief: b.id, p_comment: 'OK for air' }), 'owner approve');
  const pkg = ok(await sb.rpc('export_brief_package', { p_brief: b.id }), 'export');
  writeFileSync('demo-export-package.json', JSON.stringify(pkg, null, 2));
  log('exported package', { credits: (pkg as any).credits, clips: (pkg as any).clips.length, external_sources: (pkg as any).external_sources.length });

  // Archive memory and promises
  const promises = ok(await sb.from('promise_board').select('verbatim_text,due_phrase,suggested_due_on,status').eq('source_id', src.id), 'promises');
  log('promise candidates', promises);
  const report = ok(await sb.from('post_show_reports').select('status,body').eq('source_id', src.id).maybeSingle(), 'report') as { body: { summary: string } } | null;
  log('post-show report', report ? report.body.summary : 'none');
  const recall = ok(await sb.rpc('recall_search', { p_org: org, p_query: 'drains', p_limit: 5 }), 'recall') as { quote: string }[];
  log('recall "drains"', recall.map((r) => r.quote.trim()));
  const audit = ok(await admin.from('audit_events').select('action').eq('org_id', org), 'audit') as { action: string }[];
  log(`audit trail: ${audit.length} events`, [...new Set(audit.map((a) => a.action))]);
  log('model used', cfg.anthropicKey ? 'Anthropic API' : 'scripted stand-in (no ANTHROPIC_API_KEY)');
  log('open the app and sign in as', `${email} / ${password}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
