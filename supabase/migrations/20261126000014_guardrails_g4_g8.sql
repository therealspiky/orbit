-- Guardrails G4 (flag wording never leaves in social copy) and G8 (Twi beta blocks export until language review).

create or replace function public.has_flag_language(p_org uuid, p_text text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(p_text, '') ~* '(said|says|saying) the opposite|possible tension|contradict(s|ed|ion)? (himself|herself|themselves|what)'
      or exists (select 1 from recall_flags f
                  where f.org_id = p_org and f.kind = 'contradiction_candidate' and length(f.summary) > 20
                    and position(normalise_text(f.summary) in normalise_text(p_text)) > 0)
$$;

create or replace function public.clips_reject_flag_language() returns trigger
language plpgsql as $$
begin
  if has_flag_language(new.org_id, concat_ws(' ', new.headline, new.caption_text)) then
    raise exception 'Clip copy cannot repeat a possible-tension flag; flags are for editorial review only';
  end if;
  return new;
end $$;
create trigger clips_flag_language before insert or update of headline, caption_text on public.clips
  for each row execute function public.clips_reject_flag_language();

create or replace function public.export_brief_package(p_brief uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare b briefs; v_owner boolean; v_out jsonb;
begin
  select * into b from briefs where id = p_brief for update;
  if b.id is null or not can_read_brief(b.id) or is_commercial_only(b.org_id)
     or not has_scope(b.org_id, b.brand_id, b.show_id, work_roles()) then
    raise exception 'Not permitted' using errcode = '42501';
  end if;
  if b.status not in ('approved', 'scheduled', 'produced', 'closed') then
    raise exception 'Export is blocked until the brief is approved (it is %)', b.status;
  end if;
  -- G8: a Twi-beta source needs a passed language check (not "not applicable") on this version before export.
  if exists (select 1 from sources s where s.id = b.origin_source_id and s.twi_beta)
     and not exists (select 1 from review_decisions d where d.brief_version_id = b.current_version_id
                       and d.check_key = 'language' and d.outcome = 'passed' and d.invalidated_at is null) then
    raise exception 'Export is blocked: this brief cites a Twi (beta) source and needs a passed language review';
  end if;
  -- G4: possible-tension wording is flag-only; it can never leave in social copy.
  if exists (select 1 from brief_versions v, jsonb_array_elements(coalesce(v.content->'social_package', '[]')) a
              where v.id = b.current_version_id
                and has_flag_language(b.org_id, concat_ws(' ', a->>'hook', a->>'caption_draft')))
     or exists (select 1 from clips c where c.brief_id = b.id and has_flag_language(b.org_id, concat_ws(' ', c.headline, c.caption_text))) then
    raise exception 'Export is blocked: social copy repeats a possible-tension flag. Flags are for editorial review only';
  end if;
  v_owner := owner_approval_needed(b.id);
  if v_owner and b.owner_approved_at is null then
    raise exception 'Export is blocked until the brand owner gives final approval';
  end if;
  update briefs set exported_at = coalesce(exported_at, now()) where id = b.id;
  update contributions set locked_at = coalesce(locked_at, now()) where object_type = 'brief' and object_id = b.id;
  perform log_audit(b.org_id, 'brief.exported', 'brief', b.id, jsonb_build_object('owner_approval_required', v_owner));
  select jsonb_build_object(
    'brief_id', b.id, 'version_id', b.current_version_id, 'exported_at', now(),
    'credits', coalesce((select jsonb_agg(jsonb_build_object('role', c.role, 'person', coalesce(p.display_name, pr.display_name, 'Unlinked user')))
                           from contributions c left join people p on p.id = c.person_id
                           left join profiles pr on pr.user_id = c.user_id
                          where c.object_type = 'brief' and c.object_id = b.id), '[]'),
    'clips', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'headline', c.headline, 'aspect_ratio', c.aspect_ratio,
                           'video_path', c.video_path, 'srt_path', c.srt_path, 'vtt_path', c.vtt_path,
                           'caption_text', c.caption_text, 'caption_differs', c.caption_differs, 'music_flag', c.music_flag,
                           'start_ms', c.start_ms, 'end_ms', c.end_ms))
                         from clips c where c.brief_id = b.id and c.status = 'rendered' and c.rendered_revision = c.revision), '[]'),
    'external_sources', coalesce((select jsonb_agg(jsonb_build_object('url', f.url, 'publisher', f.publisher, 'title', f.title,
                           'published_on', f.published_on, 'label', f.label))
                         from external_findings f where f.used_on_brief_id = b.id and f.status = 'confirmed_for_use'), '[]')
  ) into v_out;
  return v_out;
end $$;
