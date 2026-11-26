# Status against the handoff spec

Measured against the *Orb.IT Product Handoff Specification* (26 November 2026), which supersedes the
30 October requirements where they differ. "Built" means the code exists and has automated tests.
"Verified end to end" means it ran in `worker/scripts/demo-run.ts` against a local Supabase stack on
26 Nov 2026 with a real recording, real local transcription and real clip rendering.

**What has not happened yet:** no run on real Joy Prime, Hitz FM or Adom material, and no run with a model
key. In the end-to-end run, a scripted stand-in wrote the analysis and the three briefs from the real
transcript, because no `ANTHROPIC_API_KEY` was set. All checks on that output (verbatim quotes, evidence
matching, review gates) were real. Quality of real model briefs therefore still needs the pilot.

## Day-one loop (§1.4)

| Step | State |
|---|---|
| Group > brands > shows > seasons > episodes | Built and verified. Seasons are optional; an episode's season must belong to the same show. Organisation type (media group, podcast network, agency). |
| Upload | Built and verified (fingerprint, duplicate refusal, private storage, worker re-check). |
| Transcript with correction | Built and verified. Providers: OpenAI, Deepgram (speakers), and **local faster-whisper** (no key, about 4x real time on 4 CPU cores, no speaker labels). Corrections are versioned and reach evidence, clips and promise quotes. |
| Cross-brand recommendations, 3+ shows per source | Built and verified with 3 shows on 3 brands. Shows can opt out of receiving other shows' sources. |
| Real captioned clips | Built and verified: 9:16 and 16:9 rendered (1:1 supported), captions burned in from the corrected transcript, SRT/VTT sidecars, headline and show label, brand colour from the profile's brand kit, music/non-speech flag. |
| Review | Built and verified (fact, fairness, privacy, rights, language checks; evidence verification; blocking tasks). |
| Owner approval | Built and verified. On by default for news and current affairs; export is refused until the brand owner approves. |
| Export | Built and verified. Package with credits (locked on export), clips, and confirmed external sources labelled as external. No posting to any platform. |

## User stories (§5)

| Story | State |
|---|---|
| US-001 group and brands | Built. Single- or multi-tenant instance; org switcher in the app. |
| US-002 show profile | Built (existing), plus brand kit fields used by clip rendering. |
| US-003 scoped roles | Built (existing). Commercial role added to the wall below. |
| US-010 upload | Built. Resumable uploads are not built; very large files depend on the storage limit. |
| US-011 transcription and correction | Built. Word error rate is not measured or displayed (G10). |
| US-012 Twi beta | Built: every Twi passage flagged; export is blocked until a language review passes (G8). |
| US-013 speaker identity | Built: people directory, map a speaker label to a person for the whole source, "unidentified speaker" otherwise (G2). Needs diarised transcription to have labels. |
| US-020 cross-show opportunities with citations | Built. |
| US-021 missed follow-up questions | Built in analysis and the post-show report. |
| US-022 brief workspace | Built; new tabs for clips, archive recall, external research, credits and export. |
| US-023 assign work | Built (existing tasks) plus in-app notifications on assignment. |
| US-030 social assets | Clips built. Thumbnails and quote cards are not rendered. |
| US-031 editorial and owner approval | Built. |
| US-032 export, no posting | Built. |
| US-040 guest prep sheet | Built: past quotes with player, open promises, possible tensions (labelled as flags), download as Markdown. |
| US-041 recall flags | Built after each transcript (post-show), not live during a broadcast. "Possible tension" flags need a model key and two validated citations. |
| US-042 topic recall | Built with Postgres full-text search, tenant filter inside the query (G7). **Embeddings (semantic search) are not built**, so recall matches words, not meaning. |
| US-043 promise tracker | Built: candidates from analysis with suggested due date, producer confirms, nudges before and after due, resolution needs evidence. |
| US-044 web research | Built behind a search provider (Brave or Tavily) on the worker. **Not run against a live search API yet** (no key in this environment). Findings carry a fixed external label and need an editor to confirm before use. |
| US-050 credit ledger | Built: credits written from workflow actions, editable before export, locked after. |
| US-051 people metrics | Built: airtime computed from mapped speakers, other figures need an evidence link, owner approval, equal split across credited presenters and producers when not attributed to one person. Only approved figures show. |
| US-060 audit log | Built; audit and approval records are immutable. |
| US-061 sales wall | Built in the database: commercial-only users see approved inventory only, never sources, transcripts, drafts, clips or unapproved figures. |

## Guardrails (§8.2)

| ID | State |
|---|---|
| G1 verbatim quotes | Enforced in the worker (briefs, commitments, tensions) and in the database for clips. |
| G2 named speakers | Enforced in the UI and recall; names only from mapped people. |
| G3 external findings never archive quotes | Enforced (separate table, fixed label, never in recall). |
| G4 flag wording never leaves | Enforced in the database: clip copy and exported social copy reject possible-tension wording and flag summaries. |
| G5 unapproved metrics hidden | Enforced by RLS and the approved-only view. |
| G6 sales cannot read drafts | Enforced by RLS; covered by database tests. |
| G7 tenant filter in search | Enforced inside the recall query; tested with two tenants. Applies to embeddings when they are added. |
| G8 Twi beta blocks export | Enforced in the export function. |
| G9 uncertainty | Prompted; unmatched quotes are removed. |
| G10 no invented figures | No WER, reach estimates or scores shown. |
| G11 rights flags | Music flag reads "review rights", never "cleared". |
| G12 model-improvement opt-in | Defaults false on new organisations. No pipeline uses corrections for training. |

## Not built yet

- Embeddings / semantic recall (pgvector). Full-text search stands in.
- Live in-broadcast flags (flags run after a transcript is ready).
- Thumbnails, quote cards and audiograms as separate assets (audiogram look is used for audio-only clips).
- Trusted-source lists per group and alerts on tracked people or stories.
- Email or WhatsApp notifications (in-app only).
- Resumable uploads; RSS ingestion.

## Before the pilot

1. Add `ANTHROPIC_API_KEY` (and optionally `SEARCH_API_KEY`, `DEEPGRAM_API_KEY`) to the worker and rerun
   `worker/scripts/demo-run.ts` on a real hour of Joy Prime or Hitz FM.
2. Have editors score 10 real briefs and 20 citations (AT03 to AT05).
3. Apply migrations 10 to 14 to the hosted project and run `supabase/tests/run.sh` there.
