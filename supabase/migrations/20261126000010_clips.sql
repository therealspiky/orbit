-- Rendered captioned clips (handoff spec §4.1 item 12, US-030, §6.9).
--
-- A clip is cut from a brief's origin recording between two transcript segments. Times and
-- default caption text come from the corrected transcript, never from the model. Rendering is a
-- worker job (deterministic ffmpeg). Files live under {org}/{source}/clips/{clip}/ in the private
-- media bucket, so the existing source-visibility read policy covers them.

alter type public.job_kind add value if not exists 'render_clip';

create table public.clips (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organisations(id) on delete cascade,
  brand_id         uuid not null references public.brands(id) on delete cascade,
  show_id          uuid not null references public.shows(id) on delete cascade,
  brief_id         uuid not null references public.briefs(id) on delete cascade,
  source_id        uuid not null references public.sources(id) on delete cascade,
  social_index     int,                     -- social_package entry this clip realises, if any
  segment_start    int not null,
  segment_end      int not null,
  start_ms         int not null,            -- copied from segments
  end_ms           int not null,
  aspect_ratio     text not null default '9:16' check (aspect_ratio in ('9:16', '16:9', '1:1')),
  caption_mode     text not null default 'burned' check (caption_mode in ('burned', 'sidecar')),
  headline         text not null default '' check (length(headline) <= 120),
  caption_text     text not null,           -- on-screen captions, editable
  transcript_text  text not null,           -- the corrected transcript text for the range at last save
  caption_differs  boolean not null default false,
  status           text not null default 'draft'
                   check (status in ('draft', 'queued', 'rendering', 'rendered', 'failed')),
  revision         int not null default 1,
  render_error     text,
  video_path       text,
  srt_path         text,
  vtt_path         text,
  video_checksum   text,
  rendered_revision int,
  duration_ms      int,
  -- Likely music / non-speech audio inside the range: "review this", never "cleared" (G11).
  music_flag       boolean not null default false,
  music_ranges     jsonb not null default '[]'::jsonb,
  created_by       uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (segment_end >= segment_start),
  check (end_ms > start_ms)
);
create index clips_brief on public.clips (brief_id, created_at);

alter table public.clips enable row level security;
create policy clips_select on public.clips for select to authenticated
  using (public.can_read_brief(brief_id));
-- No direct writes: create_clip / update_clip / request_clip_render, and the worker.

-- Whitespace/typography-insensitive comparison used for "caption differs from transcript".
create or replace function public.normalise_text(p text) returns text
language sql immutable as $$
  select trim(regexp_replace(lower(translate(coalesce(p, ''), '‘’“”–—', '''''""--')), '\s+', ' ', 'g'))
$$;

create or replace function public.segment_range_text(p_source uuid, p_start int, p_end int) returns text
language sql stable security definer set search_path = public as $$
  select string_agg(text, ' ' order by idx) from transcript_segments
   where source_id = p_source and idx between p_start and p_end
$$;
revoke execute on function public.segment_range_text(uuid, int, int) from public, anon, authenticated;

create or replace function public.create_clip(
  p_brief uuid, p_segment_start int, p_segment_end int,
  p_aspect text default '9:16', p_headline text default '', p_social_index int default null,
  p_caption_mode text default 'burned'
) returns uuid language plpgsql security definer set search_path = public as $$
declare b briefs; s sources; v_start int; v_end int; v_text text; v_id uuid; v_count int;
begin
  select * into b from briefs where id = p_brief;
  if b.id is null or not can_work_brief(b.id) then raise exception 'Not permitted' using errcode = '42501'; end if;
  if b.status in ('closed', 'archived', 'rejected') then raise exception 'This brief is %', b.status; end if;
  select * into s from sources where id = b.origin_source_id;
  if s.id is null then raise exception 'This brief has no origin source to cut from'; end if;
  if s.kind <> 'recording' or s.storage_path is null then
    raise exception 'Clips need an uploaded recording; this source is a %', s.kind;
  end if;
  if not s.timestamps_genuine then raise exception 'The source has no genuine timestamps'; end if;
  if p_segment_end < p_segment_start then raise exception 'End segment is before start segment'; end if;

  select min(start_ms), max(end_ms), count(*) into v_start, v_end, v_count
    from transcript_segments where source_id = s.id and idx between p_segment_start and p_segment_end;
  if v_count <> p_segment_end - p_segment_start + 1 or v_start is null or v_end is null then
    raise exception 'Segments % to % are not all in the transcript with times', p_segment_start, p_segment_end;
  end if;
  if v_end - v_start > 180000 then raise exception 'Clips are limited to 3 minutes'; end if;
  v_text := segment_range_text(s.id, p_segment_start, p_segment_end);

  insert into clips (org_id, brand_id, show_id, brief_id, source_id, social_index, segment_start, segment_end,
                     start_ms, end_ms, aspect_ratio, caption_mode, headline, caption_text, transcript_text, created_by)
  values (b.org_id, b.brand_id, b.show_id, b.id, s.id, p_social_index, p_segment_start, p_segment_end,
          v_start, v_end, coalesce(p_aspect, '9:16'), coalesce(p_caption_mode, 'burned'),
          coalesce(p_headline, ''), v_text, v_text, auth.uid())
  returning id into v_id;
  perform log_audit(b.org_id, 'clip.created', 'clip', v_id,
    jsonb_build_object('brief', b.id, 'segments', jsonb_build_array(p_segment_start, p_segment_end)));
  return v_id;
end $$;

create or replace function public.update_clip(
  p_clip uuid, p_headline text, p_caption_text text, p_aspect text default null, p_caption_mode text default null
) returns void language plpgsql security definer set search_path = public as $$
declare c clips; v_text text;
begin
  select * into c from clips where id = p_clip for update;
  if c.id is null or not can_work_brief(c.brief_id) then raise exception 'Not permitted' using errcode = '42501'; end if;
  if c.status in ('queued', 'rendering') then raise exception 'Wait for the current render to finish'; end if;
  if coalesce(trim(p_caption_text), '') = '' then raise exception 'Captions cannot be empty'; end if;
  v_text := segment_range_text(c.source_id, c.segment_start, c.segment_end);
  update clips set headline = coalesce(p_headline, ''), caption_text = p_caption_text,
         aspect_ratio = coalesce(p_aspect, aspect_ratio), caption_mode = coalesce(p_caption_mode, caption_mode),
         transcript_text = v_text,
         caption_differs = normalise_text(p_caption_text) <> normalise_text(v_text),
         status = 'draft', revision = revision + 1, updated_at = now()
   where id = c.id;
  perform log_audit(c.org_id, 'clip.edited', 'clip', c.id,
    jsonb_build_object('caption_differs', normalise_text(p_caption_text) <> normalise_text(v_text)));
end $$;

create or replace function public.request_clip_render(p_clip uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare c clips; v_job uuid;
begin
  select * into c from clips where id = p_clip for update;
  if c.id is null or not can_work_brief(c.brief_id) then raise exception 'Not permitted' using errcode = '42501'; end if;
  if c.status in ('queued', 'rendering') then raise exception 'Already rendering'; end if;
  insert into jobs (org_id, kind, payload, idempotency_key, created_by)
  values (c.org_id, 'render_clip', jsonb_build_object('clip_id', c.id, 'revision', c.revision),
          'render_clip:' || c.id || ':' || c.revision || ':' || (select count(*) from jobs j where j.payload->>'clip_id' = c.id::text),
          auth.uid())
  returning id into v_job;
  update clips set status = 'queued', render_error = null, updated_at = now() where id = c.id;
  perform log_audit(c.org_id, 'clip.render_requested', 'clip', c.id, jsonb_build_object('job', v_job, 'revision', c.revision));
  return v_job;
end $$;

-- A transcript correction inside a clip's range makes its captions stale.
create or replace function public.on_segment_corrected_clips() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.text is distinct from old.text then
    update clips set transcript_text = segment_range_text(source_id, segment_start, segment_end),
           caption_differs = normalise_text(caption_text) <> normalise_text(segment_range_text(source_id, segment_start, segment_end)),
           updated_at = now()
     where source_id = new.source_id and new.idx between segment_start and segment_end;
  end if;
  return new;
end $$;
create trigger segments_clip_staleness after update of text on public.transcript_segments
  for each row execute function public.on_segment_corrected_clips();

grant execute on function public.create_clip(uuid, int, int, text, text, int, text) to authenticated;
grant execute on function public.update_clip(uuid, text, text, text, text) to authenticated;
grant execute on function public.request_clip_render(uuid) to authenticated;
