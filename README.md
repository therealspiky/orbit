# Orb.IT by ctrl.IT

An editorial operating system for media organisations. A producer brings in a programme recording,
checks the transcript, and Orb.IT writes a complete opportunity brief for each show that can use it:
angle, fit with the show's approved profile, evidence that cites the exact passage, a timed rundown,
guest perspectives, a social plan, tasks and review checks. Editors approve specific versions;
Orb.IT never publishes on its own.

This repository is the **MVP of the 26 Nov 2026 handoff spec**: the day-one loop (upload, transcript with
correction, cross-brand briefs, rendered captioned clips, review, owner approval, export) plus Archive Recall,
the promise tracker, editor-gated web research, the credit ledger, evidence-backed scorecards and the
editorial/commercial wall. See [docs/STATUS.md](docs/STATUS.md) for what is built, what was verified and
what is still open.

```
web/       Producer app (React + Vite + TanStack + Tailwind), talks to Supabase with the user's session
worker/    Long-running job worker (Node 22 + ffmpeg): transcription, analysis, briefs, clip rendering,
           recall flags and promises, web research
supabase/  Database migrations (schema, row-level security, workflow functions) and tests
docs/      Architecture and status
```

## How it works

1. **Upload.** The browser fingerprints the file (SHA-256), creates a source record and uploads the original
   to a private storage bucket. Identical content is detected and refused as a duplicate.
2. **Transcribe.** The worker re-checks the fingerprint, probes the media with ffmpeg, and transcribes it with
   real timestamps (OpenAI `whisper-1`, Deepgram `nova-3` with speaker separation, or `local` faster-whisper
   on the worker with no key). Pasted transcripts keep
   times only if the author's text genuinely has them. Low-confidence speech and all Twi passages are flagged.
3. **Correct.** Producers fix names and passages while listening. Each correction is versioned; any brief citing
   that passage has its evidence reset and any approval on it withdrawn.
4. **Analyse.** Claude Haiku extracts themes, claims (opinion vs. assertion vs. allegation), open questions,
   usable moments and sensitivities, all tied to transcript passages.
5. **Write briefs.** For each chosen show, Claude Sonnet writes a brief from that show's approved profile, its
   previous coverage, and the treatments already proposed for sister shows (so each one is different).
   Output must match a strict schema, then deterministic checks run before anything is saved:
   quotes must appear verbatim in the cited passage or they are removed; attributions must match speaker labels;
   times come from the transcript, never the model; rundowns must add up to the slot; named guests are replaced
   with roles; a brief with no surviving evidence is downgraded to "research first".
6. **Review.** Producers verify each citation by listening. Reviewers record fact, fairness, privacy, rights and
   language checks (and commercial, when flagged) against one version. An editor approves only when every gate
   is clear. Any edit creates a new version and withdraws earlier checks and approval.
7. **Clips.** From a brief's social package or any passage range, the worker renders 9:16, 16:9 or 1:1 MP4s
   with burned-in captions from the corrected transcript, plus SRT and VTT. Edited captions are marked as
   differing; music or long non-speech is flagged "review rights", never "cleared". Correcting a passage marks
   its clips stale.
8. **Approve and export.** News and current-affairs shows (or any show set that way) need the brand owner's final
   approval after the editor's. The export package carries the brief, locked credits, rendered clips and only
   editor-confirmed outside sources, each labelled as external. Nothing is posted anywhere.
9. **Archive memory.** After analysis the worker files promise candidates, "said before", "recurring topic" and
   "open promise" flags (and, with a model key, "possible tension" flags that need two citations). Producers
   confirm promises, which then nudge the assignee before and after the due date. Archive recall, guest prep
   sheets and topic search only ever show verbatim, timed transcript passages the user may see.

## Instances and modules

An instance can serve one organisation (the first sign-up creates it; later people are added by its
administrator) or many (multi-tenant: every sign-up can create an organisation, and users switch between
the ones they belong to). A fresh database starts multi-tenant; an existing one with an organisation stays
single. Organisation type (media group, podcast network, agency) sets sensible defaults; brands are
stations, shows or clients accordingly. Features beyond the core are modules that are
licensed per instance and can be switched off or removed from the build.
See [docs/DEPLOY-INSTANCE.md](docs/DEPLOY-INSTANCE.md) and [docs/MODULES.md](docs/MODULES.md).

## Setup

You need a Supabase project and an Anthropic API key; an OpenAI or Deepgram key only if recordings are transcribed.

### 1. Database

```bash
npm install -g supabase            # or use npx supabase
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase db push                   # applies supabase/migrations/*
```

In the Supabase dashboard:
- **Storage:** the `media` bucket is created by the migrations. For long recordings raise the
  global upload size limit (Settings > Storage); the free plan caps uploads at 50 MB.
- **Auth:** email/password is used. Decide whether new sign-ups need email confirmation.

### 2. Worker

```bash
cd worker
cp .env.example .env               # fill in Supabase URL + service role key, Anthropic and OpenAI/Deepgram keys
npm install
npm start                          # needs ffmpeg on PATH
```

To transcribe without an API key, set `TRANSCRIBE_PROVIDER=local` and install faster-whisper:
`python3 -m venv ~/whisper && ~/whisper/bin/pip install faster-whisper`, download a model folder
(for example `Systran/faster-whisper-small` from Hugging Face), and set `WHISPER_PYTHON=~/whisper/bin/python`
and `WHISPER_MODEL_DIR` to that folder. The Docker image does this for you. Local transcription has no
speaker labels; use Deepgram when you need speakers mapped to people. Clip captions use the Inter font
(`fonts-inter` on Debian/Ubuntu); another sans-serif is substituted if it is missing.

On Windows (Command Prompt):

```bat
cd worker
copy .env.example .env
notepad .env
winget install Gyan.FFmpeg
rem open a NEW terminal so ffmpeg is on PATH, then:
npm install
npm start
```

Or build the container: `docker build -t orbit-worker worker/` and run it with the same environment
on any host that keeps a process running (a VPS, Railway, Fly.io, Render, or your Mac during development).
Run more than one worker for throughput; jobs are claimed with `SKIP LOCKED`.

The service role key bypasses row-level security. It belongs only on the worker host, never in the web app.

### 3. Web app

```bash
cd web
npm install
npm run dev                        # http://localhost:5173
```

The project URL and anon key are already in `web/.env.development` and `web/.env.production`
(the anon key is public by design; row-level security protects the data).

**Deploy:** import the GitHub repo into Vercel, Netlify or Cloudflare Pages with root directory `web`,
build command `npm run build`, output directory `dist`. SPA routing is configured (`vercel.json`, `public/_redirects`).
Then in Supabase **Authentication → URL Configuration**, set the Site URL to the deployed address so
confirmation emails link back to the app.

### YouTube (optional)

Paste a YouTube link in Add source to fill in the video's details; connect your channels to import their captions automatically. Setup: [docs/YOUTUBE.md](docs/YOUTUBE.md).

### 4. First run

1. The first person to sign up names the organisation and becomes its administrator (once per instance).
2. Add brands and shows. Ask colleagues to sign up, then add them with a role and scope.
3. Fill in and approve each show's profile (episode length, tone, audience, boundaries).
4. Add a recording, wait for the transcript, correct uncertain passages.
5. Choose destination shows and write briefs.

## Tests

```bash
supabase/tests/run.sh              # 152 database checks on a throwaway PostgreSQL 16
cd worker && npm test              # 96 tests: validation, parsing, captions, promises, map, YouTube, modules
cd web && npm run build            # typecheck + production build
```

The database suite covers tenant isolation, scoped roles, source sharing scope, immutable source
fingerprints, idempotent jobs, version-bound approval, and approval withdrawal after edits and source corrections, one organisation per instance, and module licensing.

## End-to-end demo (local stack)

`worker/scripts/demo-run.ts` runs the whole loop against a local Supabase (`supabase start`) as a signed-in
user: organisation with three brands and four shows, upload of a sample recording, local transcription,
corrections, three cross-brand briefs, evidence verification, review checks, two rendered clips, editor and
owner approval, and the export package. Without `ANTHROPIC_API_KEY` a clearly labelled scripted stand-in
fills the analysis and brief model calls from the real transcript; with a key, the real model runs.

## Costs (planning figures, October 2026 list prices)

Per programme hour, writing three briefs: transcription about $0.27–0.36, Haiku extraction about $0.01,
Sonnet briefs about $0.25 (less with prompt caching, which the worker uses for the transcript).
Roughly $0.55–0.75 per hour of source in total. Supabase Pro is $25/month plus compute.
