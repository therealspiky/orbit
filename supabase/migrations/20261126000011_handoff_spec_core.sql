-- Handoff spec (26 Nov 2026) data model on top of the Phase 1 spine:
--   tenancy (org type, multi-organisation instances), seasons, people + speaker identity,
--   editorial/commercial wall, owner approval and export gate, notifications, contributor
--   credit ledger, evidence-backed metrics with approval, promises, recall flags,
--   web research findings, and the full-text index used by Archive Recall.
-- Authorisation stays in the database (RLS + security-definer RPCs).

alter type public.job_kind add value if not exists 'web_research';
alter type public.job_kind add value if not exists 'recall_flags';
alter type public.job_kind add value if not exists 'promise_nudges';

-- ===========================================================================
-- Tenancy: organisation type and multi-organisation instances (spec §1.3, §3.4)
-- ===========================================================================
alter table public.organisations
  add column if not exists org_type text not null default 'media_group'
    check (org_type in ('media_group', 'podcast_network', 'agency', 'other'));

create table if not exists public.instance_config (
  key   text primary key,
  value jsonb not null
);
alter table public.instance_config enable row level security;
create policy instance_config_select on public.instance_config for select to authenticated using (true);
-- Existing single-client instances stay single; new installs are multi-organisation SaaS.
insert into public.instance_config (key, value)
select 'tenancy', to_jsonb(case when exists (select 1 from public.organisations) then 'single' else 'multi' end)
on conflict (key) do nothing;

create or replace function public.instance_tenancy() returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select value #>> '{}' from instance_config where key = 'tenancy'), 'multi')
$$;

drop function if exists public.create_organisation(text);
create or replace function public.create_organisation(p_name text, p_type text default 'media_group') returns uuid
language plpgsql security definer set search_path = public as $$
declare v_org uuid;
begin
  if auth.uid() is null then raise exception 'Not signed in' using errcode = '42501'; end if;
  if p_type not in ('media_group', 'podcast_network', 'agency', 'other') then raise exception 'Unknown organisation type %', p_type; end if;
  if instance_tenancy() = 'single' then
    perform pg_advisory_xact_lock(hashtext('orbit.create_organisation'));
    if exists (select 1 from organisations) then
      raise exception 'This Orb.IT instance already has an organisation. Ask its administrator to add you.' using errcode = '42501';
    end if;
  end if;
  insert into organisations (name, org_type, created_by, settings)
  values (p_name, p_type, auth.uid(), jsonb_build_object(
    'cross_brand_visibility', case when p_type = 'agency' then 'assigned_brands_only' else 'all_internal' end,
    'retention_days', 730, 'allow_corrections_for_model_improvement', false))
  returning id into v_org;
  insert into memberships (org_id, user_id, role) values (v_org, auth.uid(), 'org_admin');
  perform log_audit(v_org, 'organisation.created', 'organisation', v_org, jsonb_build_object('name', p_name, 'type', p_type));
  return v_org;
end $$;
grant execute on function public.create_organisation(text, text) to authenticated;

create or replace function public.instance_status() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'tenancy', instance_tenancy(),
    'has_organisation', exists (select 1 from organisations),
    'organisation_name', (select name from organisations order by created_at limit 1),
    'is_member', exists (select 1 from memberships where user_id = auth.uid())
  )
$$;

-- ===========================================================================
-- Editorial / commercial wall (spec §3.3, G6): a user whose only role in the
-- organisation is commercial never reads sources, transcripts, drafts or
-- unapproved material. Hard rule in the read helpers, not a UI hide.
-- ===========================================================================
create or replace function public.is_commercial_only(p_org uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from memberships where org_id = p_org and user_id = auth.uid())
     and not exists (select 1 from memberships where org_id = p_org and user_id = auth.uid() and role <> 'commercial')
$$;

create or replace function public.source_visible(
  p_org uuid, p_brand uuid, p_show uuid, p_scope public.share_scope
) returns boolean
language sql stable security definer set search_path = public as $$
  select not public.is_commercial_only(p_org) and (
         public.has_scope(p_org, p_brand, p_show, public.all_roles())
      or (p_scope = 'organisation' and public.is_member(p_org))
      or (p_scope = 'brand' and public.touches_brand(p_org, p_brand))
      or (p_scope = 'show' and p_show is null and public.touches_brand(p_org, p_brand)))
$$;

create or replace function public.brief_visible(
  p_org uuid, p_brand uuid, p_show uuid, p_status public.brief_status
) returns boolean
language sql stable security definer set search_path = public as $$
  select public.has_scope(p_org, p_brand, p_show, public.all_roles())
     and (not public.is_commercial_only(p_org) or p_status in ('approved', 'scheduled', 'produced', 'closed'))
$$;

create or replace function public.can_read_brief(p_brief uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from briefs b where b.id = p_brief
                 and public.brief_visible(b.org_id, b.brand_id, b.show_id, b.status))
$$;

drop policy if exists briefs_select on public.briefs;
create policy briefs_select on public.briefs for select to authenticated
  using (public.brief_visible(org_id, brand_id, show_id, status));
drop policy if exists brief_versions_select on public.brief_versions;
create policy brief_versions_select on public.brief_versions for select to authenticated
  using (public.can_read_brief(brief_id) and not public.is_commercial_only(org_id));
drop policy if exists evidence_select on public.evidence;
create policy evidence_select on public.evidence for select to authenticated
  using (not public.is_commercial_only(org_id) and exists (
    select 1 from public.brief_versions v where v.id = brief_version_id and public.can_read_brief(v.brief_id)));
drop policy if exists reviews_select on public.review_decisions;
create policy reviews_select on public.review_decisions for select to authenticated
  using (public.can_read_brief(brief_id) and not public.is_commercial_only(org_id));
drop policy if exists tasks_select on public.research_tasks;
create policy tasks_select on public.research_tasks for select to authenticated
  using (public.can_read_brief(brief_id) and not public.is_commercial_only(org_id));
drop policy if exists comments_select on public.brief_comments;
create policy comments_select on public.brief_comments for select to authenticated
  using (public.can_read_brief(brief_id) and not public.is_commercial_only(org_id));
drop policy if exists jobs_select on public.jobs;
create policy jobs_select on public.jobs for select to authenticated
  using (public.is_member(org_id) and not public.is_commercial_only(org_id));
drop policy if exists clips_select on public.clips;
create policy clips_select on public.clips for select to authenticated
  using (public.can_read_brief(brief_id) and not public.is_commercial_only(org_id));

-- ===========================================================================
-- Shows: editorial category, owner approval and commercial opt-out (spec §6.1)
-- ===========================================================================
alter table public.shows
  add column if not exists editorial_category text not null default 'other'
    check (editorial_category in ('entertainment', 'lifestyle', 'news', 'current_affairs', 'sport', 'other')),
  add column if not exists owner_approval_required boolean not null default false,
  add column if not exists exclude_from_commercial_matching boolean not null default false,
  add column if not exists cross_show_recommendation_opt_in boolean not null default true,
  add column if not exists recent_coverage_days int not null default 30 check (recent_coverage_days between 1 and 365);

create or replace function public.update_show_settings(
  p_show uuid, p_category text, p_owner_approval boolean, p_exclude_commercial boolean, p_opt_in boolean
) returns void language plpgsql security definer set search_path = public as $$
declare s shows;
begin
  select * into s from shows where id = p_show;
  if s.id is null or not has_scope(s.org_id, s.brand_id, null, array['org_admin', 'brand_editor']::member_role[]) then
    raise exception 'Only the brand owner or an administrator can change show policy' using errcode = '42501';
  end if;
  update shows set editorial_category = p_category, owner_approval_required = p_owner_approval,
         exclude_from_commercial_matching = p_exclude_commercial, cross_show_recommendation_opt_in = p_opt_in
   where id = s.id;
  perform log_audit(s.org_id, 'show.policy_changed', 'show', s.id, jsonb_build_object(
    'category', p_category, 'owner_approval_required', p_owner_approval,
    'exclude_from_commercial_matching', p_exclude_commercial, 'cross_show_recommendation_opt_in', p_opt_in));
end $$;

-- News and current affairs default to owner approval and no sponsorship matching (spec §3.3, US-031).
create or replace function public.show_category_defaults() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' and new.editorial_category in ('news', 'current_affairs') then
    new.owner_approval_required := true;
    new.exclude_from_commercial_matching := true;
  end if;
  return new;
end $$;
create trigger shows_category_defaults before insert on public.shows
  for each row execute function public.show_category_defaults();

-- ===========================================================================
-- Seasons (optional parent of episodes, spec §6.1)
-- ===========================================================================
create table public.seasons (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organisations(id) on delete cascade,
  brand_id   uuid not null references public.brands(id) on delete cascade,
  show_id    uuid not null references public.shows(id) on delete cascade,
  name       text not null check (length(trim(name)) > 0),
  number     int,
  starts_on  date,
  ends_on    date,
  status     text not null default 'planned' check (status in ('planned', 'active', 'completed', 'archived')),
  created_at timestamptz not null default now(),
  unique (show_id, name),
  check (ends_on is null or starts_on is null or ends_on >= starts_on)
);
alter table public.seasons enable row level security;
create policy seasons_select on public.seasons for select to authenticated
  using (public.has_scope(org_id, brand_id, show_id, public.all_roles()) or public.touches_brand(org_id, brand_id));
create policy seasons_insert on public.seasons for insert to authenticated
  with check (public.has_scope(org_id, brand_id, show_id, public.editor_roles() || array['producer']::public.member_role[])
              and exists (select 1 from public.shows s where s.id = show_id and s.brand_id = seasons.brand_id and s.org_id = seasons.org_id));
create policy seasons_update on public.seasons for update to authenticated
  using (public.has_scope(org_id, brand_id, show_id, public.editor_roles() || array['producer']::public.member_role[]));

alter table public.episodes add column if not exists season_id uuid references public.seasons(id) on delete set null;
create or replace function public.guard_episode_season() returns trigger
language plpgsql as $$
begin
  if new.season_id is not null and not exists (select 1 from seasons where id = new.season_id and show_id = new.show_id) then
    raise exception 'Season belongs to a different show';
  end if;
  return new;
end $$;
create trigger episodes_season_guard before insert or update of season_id, show_id on public.episodes
  for each row execute function public.guard_episode_season();

-- ===========================================================================
-- People directory and speaker identity (spec §6.2, US-013, G2)
-- ===========================================================================
create table public.people (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references public.organisations(id) on delete cascade,
  user_id             uuid,
  display_name        text not null check (length(trim(display_name)) > 0),
  kind                text not null default 'guest' check (kind in ('staff', 'guest', 'public_figure', 'other')),
  title               text,
  affiliation         text,
  bio                 text,
  languages           text[] not null default '{}',
  expertise_tags      text[] not null default '{}',
  consent_status      text not null default 'unknown' check (consent_status in ('unknown', 'recorded', 'not_required', 'withdrawn')),
  consent_notes       text,
  verification_status text not null default 'unverified' check (verification_status in ('unverified', 'verified')),
  anonymised_at       timestamptz,
  created_by          uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create unique index people_org_user on public.people (org_id, user_id) where user_id is not null;
create index people_org_name on public.people (org_id, lower(display_name));

-- Contact details are restricted (not sales, not digital desk) — spec §12.2.
create table public.person_contacts (
  person_id  uuid primary key references public.people(id) on delete cascade,
  org_id     uuid not null references public.organisations(id) on delete cascade,
  contact    jsonb not null default '{}'::jsonb,
  source_of_contact text,
  updated_at timestamptz not null default now()
);

create table public.episode_credits (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organisations(id) on delete cascade,
  episode_id  uuid not null references public.episodes(id) on delete cascade,
  person_id   uuid not null references public.people(id) on delete cascade,
  credit_role text not null check (credit_role in ('presenter', 'producer', 'guest', 'contributor', 'other')),
  created_at  timestamptz not null default now(),
  unique (episode_id, person_id, credit_role)
);

alter table public.transcript_segments add column if not exists person_id uuid references public.people(id) on delete set null;
create index if not exists segments_person on public.transcript_segments (org_id, person_id) where person_id is not null;

alter table public.people enable row level security;
alter table public.person_contacts enable row level security;
alter table public.episode_credits enable row level security;
create policy people_select on public.people for select to authenticated
  using (public.is_member(org_id) and not public.is_commercial_only(org_id));
create policy people_insert on public.people for insert to authenticated
  with check (public.has_scope(org_id, null, null, array['org_admin']::public.member_role[])
              or exists (select 1 from public.memberships m where m.org_id = people.org_id and m.user_id = auth.uid()
                         and m.role = any(public.work_roles())));
create policy people_update on public.people for update to authenticated
  using (exists (select 1 from public.memberships m where m.org_id = people.org_id and m.user_id = auth.uid()
                 and m.role = any(public.work_roles())));
create policy contacts_select on public.person_contacts for select to authenticated
  using (exists (select 1 from public.memberships m where m.org_id = person_contacts.org_id and m.user_id = auth.uid()
                 and m.role in ('org_admin', 'brand_editor', 'show_editor', 'producer', 'researcher')));
create policy contacts_write on public.person_contacts for insert to authenticated
  with check (exists (select 1 from public.memberships m where m.org_id = person_contacts.org_id and m.user_id = auth.uid()
                 and m.role in ('org_admin', 'brand_editor', 'show_editor', 'producer', 'researcher')));
create policy contacts_update on public.person_contacts for update to authenticated
  using (exists (select 1 from public.memberships m where m.org_id = person_contacts.org_id and m.user_id = auth.uid()
                 and m.role in ('org_admin', 'brand_editor', 'show_editor', 'producer', 'researcher')));
create policy credits_select on public.episode_credits for select to authenticated
  using (exists (select 1 from public.episodes e where e.id = episode_id
                 and public.has_scope(e.org_id, e.brand_id, e.show_id, public.all_roles())));
create policy credits_insert on public.episode_credits for insert to authenticated
  with check (exists (select 1 from public.episodes e where e.id = episode_id and e.org_id = episode_credits.org_id
                      and public.has_scope(e.org_id, e.brand_id, e.show_id, public.work_roles()))
              and exists (select 1 from public.people p where p.id = person_id and p.org_id = episode_credits.org_id));
create policy credits_delete on public.episode_credits for delete to authenticated
  using (exists (select 1 from public.episodes e where e.id = episode_id
                 and public.has_scope(e.org_id, e.brand_id, e.show_id, public.work_roles())));

-- Map a diarised (or producer-assigned) speaker label to a person, retroactively for the whole source.
create or replace function public.map_speaker(p_source uuid, p_label text, p_person uuid) returns int
language plpgsql security definer set search_path = public as $$
declare s sources; n int;
begin
  select * into s from sources where id = p_source;
  if s.id is null or not can_edit_source(s.id) then raise exception 'Not permitted' using errcode = '42501'; end if;
  if p_person is not null and not exists (select 1 from people where id = p_person and org_id = s.org_id) then
    raise exception 'Person not found in this organisation';
  end if;
  update transcript_segments set person_id = p_person where source_id = s.id and speaker = p_label;
  get diagnostics n = row_count;
  perform log_audit(s.org_id, 'speaker.mapped', 'source', s.id, jsonb_build_object('label', p_label, 'person', p_person, 'segments', n));
  return n;
end $$;

-- Admin-initiated export / anonymisation of a person's personal data (Act 843, spec §12.2).
create or replace function public.export_person_data(p_person uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p people;
begin
  select * into p from people where id = p_person;
  if p.id is null or not has_scope(p.org_id, null, null, array['org_admin']::member_role[]) then
    raise exception 'Only an administrator can export personal data' using errcode = '42501';
  end if;
  perform log_audit(p.org_id, 'person.data_exported', 'person', p.id, '{}'::jsonb);
  return jsonb_build_object('person', to_jsonb(p),
    'contact', (select to_jsonb(c) from person_contacts c where c.person_id = p.id),
    'credits', (select coalesce(jsonb_agg(to_jsonb(c)), '[]') from episode_credits c where c.person_id = p.id),
    'segments_spoken', (select count(*) from transcript_segments t where t.person_id = p.id),
    'note', 'Broadcast recordings in which this person appears are editorial archive and are not deleted by this export.');
end $$;

create or replace function public.anonymise_person(p_person uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare p people;
begin
  select * into p from people where id = p_person;
  if p.id is null or not has_scope(p.org_id, null, null, array['org_admin']::member_role[]) then
    raise exception 'Only an administrator can anonymise personal data' using errcode = '42501';
  end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Record the reason (e.g. data-subject request)'; end if;
  delete from person_contacts where person_id = p.id;
  update people set display_name = 'Anonymised person', title = null, affiliation = null, bio = null,
         expertise_tags = '{}', consent_status = 'withdrawn', consent_notes = p_reason, anonymised_at = now(), user_id = null
   where id = p.id;
  perform log_audit(p.org_id, 'person.anonymised', 'person', p.id, jsonb_build_object('reason', p_reason,
    'archive_note', 'Recordings and segments retained as editorial archive; review legal hold separately.'));
end $$;

-- ===========================================================================
-- Notifications (in-app; spec §6.12)
-- ===========================================================================
create table public.notifications (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organisations(id) on delete cascade,
  user_id    uuid not null,
  kind       text not null,
  title      text not null,
  body       text,
  link       text,
  dedupe_key text,
  read_at    timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, dedupe_key)
);
create index notifications_user on public.notifications (user_id, created_at desc);
alter table public.notifications enable row level security;
create policy notifications_select on public.notifications for select to authenticated using (user_id = auth.uid());
create policy notifications_update on public.notifications for update to authenticated using (user_id = auth.uid());

create or replace function public.notify(p_org uuid, p_user uuid, p_kind text, p_title text, p_body text, p_link text, p_dedupe text default null)
returns void language sql security definer set search_path = public as $$
  insert into notifications (org_id, user_id, kind, title, body, link, dedupe_key)
  select p_org, p_user, p_kind, p_title, p_body, p_link, p_dedupe where p_user is not null
  on conflict (user_id, dedupe_key) do nothing;
$$;
revoke execute on function public.notify(uuid, uuid, text, text, text, text, text) from public, anon, authenticated;

create or replace function public.on_brief_assigned() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.assigned_to is not null and new.assigned_to is distinct from old.assigned_to then
    perform notify(new.org_id, new.assigned_to, 'assignment', 'Brief assigned to you: ' || new.title,
      case when new.decision_deadline is not null then 'Due ' || new.decision_deadline end,
      '/briefs/' || new.id, 'assign:' || new.id || ':' || new.assigned_to);
    perform log_audit(new.org_id, 'brief.assigned', 'brief', new.id, jsonb_build_object('to', new.assigned_to));
  end if;
  if new.status is distinct from old.status and new.created_by is not null
     and new.status in ('approved', 'rejected') then
    perform notify(new.org_id, new.created_by, 'approval', 'Brief ' || new.status || ': ' || new.title, new.status_reason,
      '/briefs/' || new.id, 'status:' || new.id || ':' || new.status || ':' || now());
  end if;
  return new;
end $$;
create trigger briefs_notify after update on public.briefs for each row execute function public.on_brief_assigned();

create or replace function public.on_job_finished() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status is distinct from old.status and new.status in ('succeeded', 'failed') and new.created_by is not null
     and new.kind::text in ('transcribe', 'analyse', 'generate_briefs', 'render_clip', 'web_research') then
    perform notify(new.org_id, new.created_by, 'job_' || new.status::text,
      initcap(replace(new.kind::text, '_', ' ')) || case when new.status = 'succeeded' then ' finished' else ' failed' end,
      coalesce(new.error, new.message),
      case when new.payload ? 'source_id' then '/sources/' || (new.payload->>'source_id') end,
      'job:' || new.id || ':' || new.status::text);
  end if;
  return new;
end $$;
create trigger jobs_notify after update on public.jobs for each row execute function public.on_job_finished();

-- ===========================================================================
-- Owner approval and the export gate (US-031, US-032)
-- ===========================================================================
alter table public.briefs add column if not exists owner_approved_at timestamptz,
                          add column if not exists owner_approved_by uuid,
                          add column if not exists exported_at timestamptz;

create or replace function public.owner_approval_needed(p_brief uuid) returns boolean
language plpgsql stable security definer set search_path = public as $$
begin
  return (select coalesce(sh.owner_approval_required, false)
      or exists (select 1 from external_findings f where f.used_on_brief_id = b.id and f.status = 'confirmed_for_use')
      or exists (select 1 from recall_flags r where r.included_in_brief_id = b.id and r.kind = 'contradiction_candidate')
    from briefs b join shows sh on sh.id = b.show_id where b.id = p_brief);
end $$;

create or replace function public.owner_approve_brief(p_brief uuid, p_comment text default null) returns void
language plpgsql security definer set search_path = public as $$
declare b briefs;
begin
  select * into b from briefs where id = p_brief for update;
  if b.id is null or not has_scope(b.org_id, b.brand_id, null, array['org_admin', 'brand_editor']::member_role[]) then
    raise exception 'Only the brand owner can give final approval' using errcode = '42501';
  end if;
  if b.status <> 'approved' then raise exception 'Editorial approval comes first (brief is %)', b.status; end if;
  update briefs set owner_approved_at = now(), owner_approved_by = auth.uid() where id = b.id;
  insert into contributions (org_id, object_type, object_id, user_id, person_id, role)
  values (b.org_id, 'brief', b.id, auth.uid(), (select id from people where org_id = b.org_id and user_id = auth.uid()), 'approved')
  on conflict do nothing;
  perform log_audit(b.org_id, 'brief.owner_approved', 'brief', b.id, jsonb_build_object('comment', p_comment));
end $$;

-- ===========================================================================
-- Contributor credit ledger (US-050, §6.10)
-- ===========================================================================
create table public.contributions (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organisations(id) on delete cascade,
  object_type text not null check (object_type in ('brief', 'clip', 'episode', 'prep_sheet')),
  object_id   uuid not null,
  user_id     uuid,
  person_id   uuid references public.people(id) on delete set null,
  role        text not null check (role in ('sourced', 'produced', 'edited', 'approved', 'assigned')),
  weight      numeric not null default 1 check (weight > 0),
  note        text,
  locked_at   timestamptz,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  check (user_id is not null or person_id is not null)
);
create unique index contributions_unique on public.contributions
  (object_type, object_id, role, coalesce(person_id, '00000000-0000-0000-0000-000000000000'::uuid),
   coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid));
alter table public.contributions enable row level security;
create policy contributions_select on public.contributions for select to authenticated
  using (public.is_member(org_id) and not public.is_commercial_only(org_id));

create or replace function public.person_for_user(p_org uuid, p_user uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select id from people where org_id = p_org and user_id = p_user
$$;

create or replace function public.credit(p_org uuid, p_type text, p_id uuid, p_user uuid, p_role text)
returns void language sql security definer set search_path = public as $$
  insert into contributions (org_id, object_type, object_id, user_id, person_id, role, created_by)
  select p_org, p_type, p_id, p_user, person_for_user(p_org, p_user), p_role, p_user where p_user is not null
  on conflict do nothing;
$$;
revoke execute on function public.credit(uuid, text, uuid, uuid, text) from public, anon, authenticated;

create or replace function public.credit_on_brief() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform credit(new.org_id, 'brief', new.id, new.created_by, 'sourced');
  elsif new.assigned_to is distinct from old.assigned_to and new.assigned_to is not null then
    perform credit(new.org_id, 'brief', new.id, new.assigned_to, 'produced');
  end if;
  return new;
end $$;
create trigger briefs_credit after insert or update of assigned_to on public.briefs
  for each row execute function public.credit_on_brief();

create or replace function public.credit_on_review() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform credit(new.org_id, 'brief', new.brief_id, new.reviewer, case when new.is_final_approval then 'approved' else 'edited' end);
  return new;
end $$;
create trigger reviews_credit after insert on public.review_decisions
  for each row execute function public.credit_on_review();

create or replace function public.credit_on_clip() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform credit(new.org_id, 'brief', new.brief_id, new.created_by, 'produced');
  return new;
end $$;
create trigger clips_credit after insert on public.clips for each row execute function public.credit_on_clip();

-- Editors/owners correct credits before export; afterwards changes are audited amendments.
create or replace function public.set_contribution(
  p_type text, p_object uuid, p_person uuid, p_role text, p_remove boolean default false, p_note text default null
) returns void language plpgsql security definer set search_path = public as $$
declare b briefs; v_locked boolean;
begin
  if p_type <> 'brief' then raise exception 'Credits are edited on briefs'; end if;
  select * into b from briefs where id = p_object;
  if b.id is null or not has_scope(b.org_id, b.brand_id, b.show_id, editor_roles()) then
    raise exception 'Only an editor or owner can correct credits' using errcode = '42501';
  end if;
  if not exists (select 1 from people where id = p_person and org_id = b.org_id) then raise exception 'Person not found'; end if;
  v_locked := b.exported_at is not null;
  if p_remove then
    delete from contributions where object_type = 'brief' and object_id = b.id and person_id = p_person and role = p_role;
  else
    insert into contributions (org_id, object_type, object_id, person_id, role, note, created_by)
    values (b.org_id, 'brief', b.id, p_person, p_role, p_note, auth.uid()) on conflict do nothing;
  end if;
  perform log_audit(b.org_id, case when v_locked then 'credit.amended_after_export' else 'credit.edited' end, 'brief', b.id,
    jsonb_build_object('person', p_person, 'role', p_role, 'removed', p_remove, 'note', p_note));
end $$;

-- ===========================================================================
-- Recall flags (US-041, §6.6): editor-facing, never published as claims (G4)
-- ===========================================================================
create table public.recall_flags (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organisations(id) on delete cascade,
  source_id    uuid not null references public.sources(id) on delete cascade,
  kind         text not null check (kind in ('contradiction_candidate', 'prior_statement', 'recurring_topic', 'open_promise')),
  summary      text not null,                        -- reviewer-facing wording; never exported
  person_id    uuid references public.people(id) on delete set null,
  topic        text,
  topic_count  int,
  -- [{source_id, idx}] — current segment first, then prior ones. Two or more for contradictions.
  citations    jsonb not null,
  status       text not null default 'open' check (status in ('open', 'confirmed_for_review', 'dismissed')),
  included_in_brief_id uuid references public.briefs(id) on delete set null,
  reviewed_by  uuid,
  reviewed_at  timestamptz,
  fingerprint  text not null,
  created_at   timestamptz not null default now(),
  unique (source_id, fingerprint),
  check (jsonb_array_length(citations) >= case when kind = 'contradiction_candidate' then 2 else 1 end)
);
alter table public.recall_flags enable row level security;
create policy recall_flags_select on public.recall_flags for select to authenticated
  using (public.can_read_source(source_id));

create or replace function public.review_recall_flag(p_flag uuid, p_status text) returns void
language plpgsql security definer set search_path = public as $$
declare f recall_flags; s sources;
begin
  select * into f from recall_flags where id = p_flag;
  select * into s from sources where id = f.source_id;
  if f.id is null or not has_scope(s.org_id, s.brand_id, s.show_id, editor_roles() || array['producer', 'legal_reviewer']::member_role[]) then
    raise exception 'Not permitted' using errcode = '42501';
  end if;
  if p_status not in ('confirmed_for_review', 'dismissed', 'open') then raise exception 'Unknown status'; end if;
  update recall_flags set status = p_status, reviewed_by = auth.uid(), reviewed_at = now() where id = f.id;
  perform log_audit(s.org_id, 'recall_flag.' || p_status, 'recall_flag', f.id, jsonb_build_object('kind', f.kind));
end $$;

-- ===========================================================================
-- Promise tracker (US-043, §6.7)
-- ===========================================================================
create table public.promises (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references public.organisations(id) on delete cascade,
  brand_id           uuid not null references public.brands(id) on delete cascade,
  show_id            uuid references public.shows(id) on delete set null,
  source_id          uuid not null references public.sources(id) on delete cascade,
  segment_start      int not null,
  segment_end        int not null,
  start_ms           int,
  end_ms             int,
  verbatim_text      text not null,          -- exact transcript words (validated)
  normalized_text    text,                   -- short neutral description for lists
  speaker_label      text,
  person_id          uuid references public.people(id) on delete set null,
  due_phrase         text,                   -- e.g. "by Friday", as spoken
  suggested_due_on   date,                   -- model suggestion, never authoritative
  due_on             date,                   -- set by a human on confirmation
  status             text not null default 'candidate'
                     check (status in ('candidate', 'confirmed', 'nudge_sent', 'fulfilled', 'broken', 'dismissed')),
  assignee           uuid,
  follow_up_show_id  uuid references public.shows(id) on delete set null,
  resolution_note    text,
  resolution_source_id uuid references public.sources(id) on delete set null,
  resolution_segment int,
  resolution_finding_id uuid,
  confirmed_by       uuid,
  confirmed_at       timestamptz,
  dismissed_reason   text,
  fingerprint        text not null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (source_id, fingerprint)
);
create index promises_org_due on public.promises (org_id, status, due_on);
alter table public.promises enable row level security;
create policy promises_select on public.promises for select to authenticated
  using (public.can_read_source(source_id));

create or replace view public.promise_board with (security_invoker = true) as
  select p.*, (p.status in ('confirmed', 'nudge_sent') and p.due_on < current_date) as is_overdue
    from public.promises p;

create or replace function public.confirm_promise(
  p_promise uuid, p_due_on date, p_assignee uuid default null, p_follow_up_show uuid default null, p_person uuid default null
) returns void language plpgsql security definer set search_path = public as $$
declare p promises; s sources;
begin
  select * into p from promises where id = p_promise for update;
  select * into s from sources where id = p.source_id;
  if p.id is null or not has_scope(s.org_id, s.brand_id, s.show_id, work_roles()) then raise exception 'Not permitted' using errcode = '42501'; end if;
  if p.status not in ('candidate', 'confirmed', 'nudge_sent') then raise exception 'Promise is already %', p.status; end if;
  if p_due_on is null then raise exception 'Set a due date'; end if;
  update promises set status = 'confirmed', due_on = p_due_on, assignee = coalesce(p_assignee, auth.uid()),
         follow_up_show_id = p_follow_up_show, person_id = coalesce(p_person, person_id),
         confirmed_by = coalesce(confirmed_by, auth.uid()), confirmed_at = coalesce(confirmed_at, now()), updated_at = now()
   where id = p.id;
  insert into approval_records (org_id, object_type, object_id, action, actor_user_id, from_status, to_status)
  values (p.org_id, 'promise', p.id, 'promise_confirm', auth.uid(), p.status, 'confirmed');
  perform log_audit(p.org_id, 'promise.confirmed', 'promise', p.id, jsonb_build_object('due_on', p_due_on));
  if coalesce(p_assignee, auth.uid()) <> auth.uid() then
    perform notify(p.org_id, p_assignee, 'promise', 'Promise to follow up, due ' || p_due_on, p.verbatim_text,
      '/promises', 'promise-assign:' || p.id || ':' || p_assignee);
  end if;
end $$;

create or replace function public.dismiss_promise(p_promise uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare p promises; s sources;
begin
  select * into p from promises where id = p_promise for update;
  select * into s from sources where id = p.source_id;
  if p.id is null or not has_scope(s.org_id, s.brand_id, s.show_id, work_roles()) then raise exception 'Not permitted' using errcode = '42501'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Say why this is not a promise'; end if;
  update promises set status = 'dismissed', dismissed_reason = p_reason, updated_at = now() where id = p.id;
  perform log_audit(p.org_id, 'promise.dismissed', 'promise', p.id, jsonb_build_object('reason', p_reason));
end $$;

-- Fulfilled / broken need a human decision AND evidence: a later segment, a confirmed web finding, or a note.
create or replace function public.resolve_promise(
  p_promise uuid, p_outcome text, p_note text, p_source uuid default null, p_segment int default null, p_finding uuid default null
) returns void language plpgsql security definer set search_path = public as $$
declare p promises; s sources;
begin
  select * into p from promises where id = p_promise for update;
  select * into s from sources where id = p.source_id;
  if p.id is null or not has_scope(s.org_id, s.brand_id, s.show_id, work_roles()) then raise exception 'Not permitted' using errcode = '42501'; end if;
  if p_outcome not in ('fulfilled', 'broken') then raise exception 'Outcome must be fulfilled or broken'; end if;
  if p.status not in ('confirmed', 'nudge_sent') then raise exception 'Only confirmed promises can be resolved'; end if;
  if coalesce(trim(p_note), '') = '' then raise exception 'Describe the evidence for this outcome'; end if;
  if p_source is not null and not exists (select 1 from transcript_segments t where t.source_id = p_source and t.idx = p_segment
                                          and t.org_id = p.org_id) then
    raise exception 'Cited segment not found';
  end if;
  if p_finding is not null and not exists (select 1 from external_findings f where f.id = p_finding and f.org_id = p.org_id
                                           and f.status = 'confirmed_for_use') then
    raise exception 'Only an editor-confirmed web finding can be cited';
  end if;
  update promises set status = p_outcome, resolution_note = p_note, resolution_source_id = p_source,
         resolution_segment = p_segment, resolution_finding_id = p_finding, updated_at = now() where id = p.id;
  perform log_audit(p.org_id, 'promise.' || p_outcome, 'promise', p.id,
    jsonb_build_object('note', p_note, 'source', p_source, 'segment', p_segment, 'finding', p_finding));
end $$;

create table public.promise_nudges (
  id            uuid primary key default gen_random_uuid(),
  promise_id    uuid not null references public.promises(id) on delete cascade,
  channel       text not null default 'in_app' check (channel in ('in_app', 'email')),
  kind          text not null check (kind in ('upcoming', 'overdue')),
  scheduled_for date not null,
  sent_at       timestamptz,
  unique (promise_id, channel, kind)
);
alter table public.promise_nudges enable row level security;
create policy promise_nudges_select on public.promise_nudges for select to authenticated
  using (exists (select 1 from public.promises p where p.id = promise_id and public.can_read_source(p.source_id)));

-- Run by the worker every few minutes: due tomorrow -> "upcoming", past due -> "overdue". Idempotent.
create or replace function public.run_promise_nudges(p_today date default current_date) returns int
language plpgsql security definer set search_path = public as $$
declare r record; n int := 0; v_kind text;
begin
  for r in select * from promises where status in ('confirmed', 'nudge_sent') and due_on is not null and due_on <= p_today + 1 loop
    v_kind := case when r.due_on < p_today then 'overdue' else 'upcoming' end;
    insert into promise_nudges (promise_id, kind, scheduled_for, sent_at) values (r.id, v_kind, p_today, now())
    on conflict do nothing;
    if found then
      n := n + 1;
      perform notify(r.org_id, coalesce(r.assignee, r.confirmed_by), 'promise',
        case when v_kind = 'overdue' then 'Overdue promise (due ' || r.due_on || ')' else 'Promise due ' || r.due_on end,
        r.verbatim_text, '/promises', 'nudge:' || r.id || ':' || v_kind);
      update promises set status = 'nudge_sent', updated_at = now() where id = r.id and status = 'confirmed';
      perform log_audit(r.org_id, 'promise.nudged', 'promise', r.id, jsonb_build_object('kind', v_kind));
    end if;
  end loop;
  return n;
end $$;
revoke execute on function public.run_promise_nudges(date) from public, anon, authenticated;

-- ===========================================================================
-- Web research layer (US-044, §6.8): external findings, kept apart from archive
-- ===========================================================================
create table public.web_research_queries (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references public.organisations(id) on delete cascade,
  query_text          text not null check (length(trim(query_text)) between 3 and 300),
  context_type        text check (context_type in ('brief', 'person', 'source', 'promise', 'topic')),
  context_id          uuid,
  brief_id            uuid references public.briefs(id) on delete cascade,
  status              text not null default 'queued' check (status in ('queued', 'done', 'failed')),
  provider            text,
  error               text,
  created_by          uuid,
  created_at          timestamptz not null default now()
);
create table public.external_findings (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organisations(id) on delete cascade,
  query_id      uuid not null references public.web_research_queries(id) on delete cascade,
  url           text not null check (url ~ '^https?://'),
  publisher     text not null,
  title         text not null,
  published_on  date,                         -- null = unknown, never invented
  retrieved_at  timestamptz not null default now(),
  excerpt       text not null check (length(excerpt) <= 600),
  label         text not null default 'External source — not an Orb.IT archive quote'
                check (label = 'External source — not an Orb.IT archive quote'),
  raw_payload   jsonb,
  status        text not null default 'retrieved' check (status in ('retrieved', 'confirmed_for_use', 'rejected')),
  confirmed_by  uuid,
  confirmed_at  timestamptz,
  used_on_brief_id uuid references public.briefs(id) on delete set null,
  created_at    timestamptz not null default now()
);
alter table public.web_research_queries enable row level security;
alter table public.external_findings enable row level security;
create or replace function public.can_see_research(p_org uuid, p_brief uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select not is_commercial_only(p_org) and (case when p_brief is null
    then exists (select 1 from memberships m where m.org_id = p_org and m.user_id = auth.uid()
                 and m.role in ('org_admin', 'brand_editor', 'show_editor', 'producer', 'researcher', 'legal_reviewer'))
    else can_read_brief(p_brief) end)
$$;
create policy wrq_select on public.web_research_queries for select to authenticated
  using (public.can_see_research(org_id, brief_id));
create policy findings_select on public.external_findings for select to authenticated
  using (exists (select 1 from public.web_research_queries q where q.id = query_id and public.can_see_research(q.org_id, q.brief_id)));

create or replace function public.request_web_research(
  p_org uuid, p_query text, p_context_type text default 'topic', p_context_id uuid default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_q uuid; v_brief uuid;
begin
  if not exists (select 1 from memberships m where m.org_id = p_org and m.user_id = auth.uid()
                 and m.role in ('org_admin', 'brand_editor', 'show_editor', 'producer', 'researcher')) then
    raise exception 'Not permitted to run web research' using errcode = '42501';
  end if;
  if p_context_type = 'brief' then
    v_brief := p_context_id;
    if not can_work_brief(v_brief) then raise exception 'Not permitted on this brief' using errcode = '42501'; end if;
  end if;
  insert into web_research_queries (org_id, query_text, context_type, context_id, brief_id, created_by)
  values (p_org, trim(p_query), p_context_type, p_context_id, v_brief, auth.uid()) returning id into v_q;
  insert into jobs (org_id, kind, payload, idempotency_key, created_by)
  values (p_org, 'web_research', jsonb_build_object('query_id', v_q), 'web:' || v_q, auth.uid());
  perform log_audit(p_org, 'web_research.requested', 'web_research_query', v_q, jsonb_build_object('query', p_query));
  return v_q;
end $$;

-- Only an editor (or owner) may confirm a finding for use on one brief.
create or replace function public.review_finding(p_finding uuid, p_decision text, p_brief uuid default null) returns void
language plpgsql security definer set search_path = public as $$
declare f external_findings; b briefs;
begin
  select * into f from external_findings where id = p_finding for update;
  if f.id is null then raise exception 'Finding not found'; end if;
  if p_decision = 'confirmed_for_use' then
    select * into b from briefs where id = p_brief;
    if b.id is null or b.org_id <> f.org_id or not has_scope(b.org_id, b.brand_id, b.show_id, editor_roles()) then
      raise exception 'Only an editor for that show can confirm a web finding for use' using errcode = '42501';
    end if;
  elsif p_decision = 'rejected' then
    if not exists (select 1 from memberships m where m.org_id = f.org_id and m.user_id = auth.uid() and m.role = any(editor_roles())) then
      raise exception 'Only an editor can reject a finding' using errcode = '42501';
    end if;
  else
    raise exception 'Decision must be confirmed_for_use or rejected';
  end if;
  update external_findings set status = p_decision, confirmed_by = auth.uid(), confirmed_at = now(),
         used_on_brief_id = case when p_decision = 'confirmed_for_use' then p_brief end where id = f.id;
  insert into approval_records (org_id, object_type, object_id, action, actor_user_id, from_status, to_status)
  values (f.org_id, 'external_finding', f.id, 'finding_confirm', auth.uid(), f.status, p_decision);
  perform log_audit(f.org_id, 'finding.' || p_decision, 'external_finding', f.id, jsonb_build_object('brief', p_brief, 'url', f.url));
end $$;

-- ===========================================================================
-- Metrics with evidence and approval (US-051, §11)
-- ===========================================================================
create table public.airtime_computations (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organisations(id) on delete cascade,
  episode_id  uuid not null references public.episodes(id) on delete cascade,
  source_id   uuid not null references public.sources(id) on delete cascade,
  person_id   uuid not null references public.people(id) on delete cascade,
  airtime_ms  int not null,
  segments    int not null,
  method      text not null default 'sum of segment durations attributed to person on the corrected transcript',
  transcript_fingerprint text,
  created_by  uuid,
  created_at  timestamptz not null default now()
);
create table public.metric_observations (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organisations(id) on delete cascade,
  episode_id       uuid not null references public.episodes(id) on delete cascade,
  brief_id         uuid references public.briefs(id) on delete set null,
  person_id        uuid references public.people(id) on delete set null,
  metric_type      text not null check (metric_type in ('airtime_ms', 'reach', 'engagement', 'revenue')),
  value            numeric not null check (value >= 0),
  unit             text not null,
  currency         text,
  platform         text,
  definition       text,
  evidence_type    text not null check (evidence_type in ('computed_transcript', 'upload', 'manual_entry', 'csv_import', 'platform_api')),
  evidence_url     text,
  evidence_path    text,
  airtime_computation_id uuid references public.airtime_computations(id) on delete restrict,
  evidence_note    text,
  source_period    text,
  status           text not null default 'draft' check (status in ('draft', 'pending_approval', 'approved', 'rejected')),
  entered_by       uuid,
  approved_by      uuid,
  approved_at      timestamptz,
  rejection_reason text,
  created_at       timestamptz not null default now(),
  check (metric_type <> 'revenue' or currency is not null),
  -- A figure cannot even be submitted without evidence (spec §7.7 constraint).
  check (status in ('draft', 'rejected') or evidence_url is not null or evidence_path is not null
         or (evidence_type = 'computed_transcript' and airtime_computation_id is not null))
);
alter table public.airtime_computations enable row level security;
alter table public.metric_observations enable row level security;
create policy airtime_select on public.airtime_computations for select to authenticated
  using (exists (select 1 from public.episodes e where e.id = episode_id and public.has_scope(e.org_id, e.brand_id, e.show_id, public.all_roles()))
         and not public.is_commercial_only(org_id));
-- Unapproved figures are visible only to people who enter or approve them (G5).
create policy metrics_select on public.metric_observations for select to authenticated
  using (exists (select 1 from public.episodes e where e.id = episode_id and (
           (status = 'approved' and public.has_scope(e.org_id, e.brand_id, e.show_id, public.all_roles()))
        or (status <> 'approved' and public.has_scope(e.org_id, e.brand_id, e.show_id,
             array['org_admin', 'brand_editor', 'show_editor', 'producer']::public.member_role[])))));

create or replace function public.compute_airtime(p_episode uuid) returns int
language plpgsql security definer set search_path = public as $$
declare e episodes; n int := 0; r record; v_comp uuid;
begin
  select * into e from episodes where id = p_episode;
  if e.id is null or not has_scope(e.org_id, e.brand_id, e.show_id, array['org_admin', 'brand_editor', 'show_editor', 'producer']::member_role[]) then
    raise exception 'Not permitted' using errcode = '42501';
  end if;
  for r in
    select t.source_id, t.person_id, sum(t.end_ms - t.start_ms)::int as ms, count(*)::int as segs
      from transcript_segments t join sources s on s.id = t.source_id
     where s.episode_id = e.id and s.kind = 'recording' and s.timestamps_genuine
       and t.person_id is not null and t.start_ms is not null and t.end_ms is not null
     group by t.source_id, t.person_id
  loop
    insert into airtime_computations (org_id, episode_id, source_id, person_id, airtime_ms, segments, created_by)
    values (e.org_id, e.id, r.source_id, r.person_id, r.ms, r.segs, auth.uid()) returning id into v_comp;
    insert into metric_observations (org_id, episode_id, person_id, metric_type, value, unit, platform, evidence_type,
                                     airtime_computation_id, evidence_note, status, entered_by)
    values (e.org_id, e.id, r.person_id, 'airtime_ms', r.ms, 'ms', 'on_air', 'computed_transcript', v_comp,
            'Computed from ' || r.segs || ' attributed transcript segments; confirm the speaker map before approving.',
            'pending_approval', auth.uid());
    n := n + 1;
  end loop;
  perform log_audit(e.org_id, 'metrics.airtime_computed', 'episode', e.id, jsonb_build_object('people', n));
  return n;
end $$;

create or replace function public.submit_metric(
  p_episode uuid, p_person uuid, p_type text, p_value numeric, p_unit text, p_platform text,
  p_evidence_type text, p_evidence_url text, p_evidence_path text, p_note text,
  p_currency text default null, p_definition text default null, p_brief uuid default null, p_period text default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare e episodes; v_id uuid;
begin
  select * into e from episodes where id = p_episode;
  if e.id is null or not has_scope(e.org_id, e.brand_id, e.show_id, array['org_admin', 'brand_editor', 'show_editor', 'producer']::member_role[]) then
    raise exception 'Not permitted' using errcode = '42501';
  end if;
  if p_type = 'airtime_ms' then raise exception 'Airtime is computed from the transcript'; end if;
  if p_evidence_type not in ('upload', 'manual_entry', 'csv_import') then raise exception 'Unsupported evidence type'; end if;
  if coalesce(p_evidence_url, '') = '' and coalesce(p_evidence_path, '') = '' then
    raise exception 'Attach evidence (a link or file) before submitting a figure';
  end if;
  if p_evidence_url is not null and p_evidence_url !~ '^https?://' then raise exception 'Evidence link must be http(s)'; end if;
  insert into metric_observations (org_id, episode_id, brief_id, person_id, metric_type, value, unit, currency, platform, definition,
                                   evidence_type, evidence_url, evidence_path, evidence_note, source_period, status, entered_by)
  values (e.org_id, e.id, p_brief, p_person, p_type, p_value, p_unit, p_currency, p_platform, p_definition,
          p_evidence_type, nullif(p_evidence_url, ''), nullif(p_evidence_path, ''), p_note, p_period, 'pending_approval', auth.uid())
  returning id into v_id;
  perform log_audit(e.org_id, 'metric.submitted', 'metric', v_id, jsonb_build_object('type', p_type, 'value', p_value, 'platform', p_platform));
  return v_id;
end $$;

-- Owner (brand editor / admin) approval. Manager-only users can be granted brand_editor on metrics later via capabilities.
create or replace function public.review_metric(p_metric uuid, p_approve boolean, p_reason text default null) returns void
language plpgsql security definer set search_path = public as $$
declare m metric_observations; e episodes;
begin
  select * into m from metric_observations where id = p_metric for update;
  select * into e from episodes where id = m.episode_id;
  if m.id is null or not has_scope(e.org_id, e.brand_id, null, array['org_admin', 'brand_editor']::member_role[]) then
    raise exception 'Only the brand owner can approve figures' using errcode = '42501';
  end if;
  if m.status <> 'pending_approval' then raise exception 'Figure is %', m.status; end if;
  if not p_approve and coalesce(trim(p_reason), '') = '' then raise exception 'Say why the figure is rejected'; end if;
  update metric_observations set status = case when p_approve then 'approved' else 'rejected' end,
         approved_by = auth.uid(), approved_at = now(), rejection_reason = case when p_approve then null else p_reason end
   where id = m.id;
  insert into approval_records (org_id, object_type, object_id, action, actor_user_id, comment, from_status, to_status)
  values (m.org_id, 'metric', m.id, case when p_approve then 'metric_approve' else 'reject' end, auth.uid(), p_reason,
          m.status, case when p_approve then 'approved' else 'rejected' end);
  perform log_audit(m.org_id, case when p_approve then 'metric.approved' else 'metric.rejected' end, 'metric', m.id,
    jsonb_build_object('reason', p_reason));
end $$;

-- Approved figures only, with the visible equal-split rule (spec §11.2). Unapproved rows never appear (G5).
create or replace view public.approved_person_metrics with (security_invoker = true) as
with approved as (
  select m.* from public.metric_observations m where m.status = 'approved'
),
episode_people as (
  select c.episode_id, c.person_id from public.episode_credits c where c.credit_role in ('presenter', 'producer')
),
counts as (
  select episode_id, count(distinct person_id) as n from episode_people group by episode_id
)
select a.id as metric_id, a.org_id, a.episode_id, a.metric_type, a.platform, a.unit, a.currency,
       coalesce(a.person_id, ep.person_id) as person_id,
       case when a.person_id is not null then a.value else a.value / nullif(c.n, 0) end as attributed_value,
       a.value as total_value,
       case when a.person_id is not null then 'Attributed directly'
            else 'Split equally among ' || c.n || ' credited presenters and producers' end as attribution_rule,
       a.evidence_type, a.evidence_url, a.approved_at
  from approved a
  left join episode_people ep on a.person_id is null and ep.episode_id = a.episode_id
  left join counts c on c.episode_id = a.episode_id
 where a.person_id is not null or ep.person_id is not null;

-- ===========================================================================
-- Approval records (insert-only), as in spec §7.7
-- ===========================================================================
create table if not exists public.approval_records (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organisations(id) on delete cascade,
  object_type   text not null,
  object_id     uuid not null,
  action        text not null,
  actor_user_id uuid,
  comment       text,
  from_status   text,
  to_status     text,
  created_at    timestamptz not null default now()
);
alter table public.approval_records enable row level security;
create policy approval_records_select on public.approval_records for select to authenticated
  using (public.is_member(org_id) and not public.is_commercial_only(org_id));
create or replace function public.immutable_row() returns trigger language plpgsql as $$
begin raise exception '% rows cannot be changed or deleted', tg_table_name using errcode = '42501'; end $$;
create trigger approval_records_immutable before update or delete on public.approval_records
  for each row execute function public.immutable_row();
create trigger audit_events_immutable before update or delete on public.audit_events
  for each row execute function public.immutable_row();

-- ===========================================================================
-- Export gate (US-031/032, G4, G8)
-- ===========================================================================
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

-- ===========================================================================
-- Archive Recall: full-text index and permission-filtered search (US-040/042, G7)
-- ===========================================================================
alter table public.transcript_segments
  add column if not exists tsv tsvector generated always as (to_tsvector('english', coalesce(text, ''))) stored;
create index if not exists segments_tsv on public.transcript_segments using gin (tsv);

-- Topic / person recall. Tenant filter is in the query itself (G7); permission filter before return.
create or replace function public.recall_search(
  p_org uuid, p_query text default null, p_person uuid default null, p_show uuid default null,
  p_from date default null, p_to date default null, p_limit int default 50, p_exclude_source uuid default null
) returns table (
  source_id uuid, segment_idx int, quote text, start_ms int, end_ms int, speaker text, person_id uuid, person_name text,
  source_title text, show_id uuid, show_name text, brand_name text, aired_on date, rank real
) language sql stable security definer set search_path = public as $$
  with q as (select case when coalesce(trim(p_query), '') = '' then null else websearch_to_tsquery('english', p_query) end as tsq)
  select t.source_id, t.idx, t.text, t.start_ms, t.end_ms, t.speaker, t.person_id, pe.display_name,
         s.title, s.show_id, sh.name, br.name, coalesce(ep.air_date, s.created_at::date),
         case when q.tsq is null then 0 else ts_rank(t.tsv, q.tsq) end
    from transcript_segments t
    join sources s on s.id = t.source_id and s.org_id = p_org
    cross join q
    left join shows sh on sh.id = s.show_id
    left join brands br on br.id = s.brand_id
    left join episodes ep on ep.id = s.episode_id
    left join people pe on pe.id = t.person_id
   where t.org_id = p_org
     and is_member(p_org)
     and source_visible(s.org_id, s.brand_id, s.show_id, s.share_scope)
     and s.status in ('ready', 'needs_attention')
     and (q.tsq is null or t.tsv @@ q.tsq)
     and (p_person is null or t.person_id = p_person)
     and (p_show is null or s.show_id = p_show)
     and (p_from is null or coalesce(ep.air_date, s.created_at::date) >= p_from)
     and (p_to is null or coalesce(ep.air_date, s.created_at::date) <= p_to)
     and (p_exclude_source is null or s.id <> p_exclude_source)
     and (q.tsq is not null or p_person is not null)
   order by 14 desc, 13 desc nulls last, t.idx
   limit least(coalesce(p_limit, 50), 200)
$$;

create table public.guest_prep_sheets (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organisations(id) on delete cascade,
  person_id   uuid not null references public.people(id) on delete cascade,
  episode_id  uuid references public.episodes(id) on delete set null,
  content     jsonb not null,
  status      text not null default 'draft' check (status in ('draft', 'editor_checked')),
  created_by  uuid,
  created_at  timestamptz not null default now()
);
alter table public.guest_prep_sheets enable row level security;
create policy prep_select on public.guest_prep_sheets for select to authenticated
  using (public.is_member(org_id) and not public.is_commercial_only(org_id));

-- Mode A: everything this person said in the archive the caller may see, plus open promises.
-- Empty archive => empty sheet (never filler).
create or replace function public.build_guest_prep(p_person uuid, p_episode uuid default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare pe people; v_id uuid; v_quotes jsonb; v_promises jsonb; v_flags jsonb;
begin
  select * into pe from people where id = p_person;
  if pe.id is null or is_commercial_only(pe.org_id) or not exists (
     select 1 from memberships m where m.org_id = pe.org_id and m.user_id = auth.uid() and m.role = any(work_roles())) then
    raise exception 'Not permitted' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(to_jsonb(r)), '[]') into v_quotes
    from recall_search(pe.org_id, null, pe.id, null, null, null, 100) r;
  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'verbatim_text', p.verbatim_text, 'due_on', p.due_on, 'status', p.status,
                    'source_id', p.source_id, 'segment_start', p.segment_start, 'start_ms', p.start_ms)), '[]') into v_promises
    from promises p where p.person_id = pe.id and p.status in ('confirmed', 'nudge_sent') and can_read_source(p.source_id);
  select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'kind', f.kind, 'summary', f.summary, 'citations', f.citations, 'status', f.status)), '[]')
    into v_flags from recall_flags f where f.person_id = pe.id and f.kind = 'contradiction_candidate' and f.status <> 'dismissed'
     and can_read_source(f.source_id);
  insert into guest_prep_sheets (org_id, person_id, episode_id, content, created_by)
  values (pe.org_id, pe.id, p_episode, jsonb_build_object(
    'person', jsonb_build_object('id', pe.id, 'name', pe.display_name, 'title', pe.title, 'affiliation', pe.affiliation),
    'quotes', v_quotes, 'open_promises', v_promises,
    'possible_tensions', v_flags,
    'empty', jsonb_array_length(v_quotes) = 0,
    'note', 'Archive quotes only. Possible tensions are flags for editorial review, not claims. Web findings are excluded unless an editor confirmed them.'),
    auth.uid()) returning id into v_id;
  perform log_audit(pe.org_id, 'recall.guest_prep', 'person', pe.id, jsonb_build_object('sheet', v_id, 'quotes', jsonb_array_length(v_quotes)));
  return v_id;
end $$;

-- ===========================================================================
-- Post-show report (lightweight, §6.11): draft until a producer accepts it
-- ===========================================================================
create table public.post_show_reports (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organisations(id) on delete cascade,
  source_id   uuid not null references public.sources(id) on delete cascade,
  transcript_fingerprint text not null,
  body        jsonb not null,
  status      text not null default 'draft' check (status in ('draft', 'accepted')),
  accepted_by uuid,
  accepted_at timestamptz,
  created_at  timestamptz not null default now(),
  unique (source_id, transcript_fingerprint)
);
alter table public.post_show_reports enable row level security;
create policy post_show_select on public.post_show_reports for select to authenticated
  using (public.can_read_source(source_id));
create or replace function public.accept_post_show_report(p_report uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r post_show_reports;
begin
  select * into r from post_show_reports where id = p_report;
  if r.id is null or not can_edit_source(r.source_id) then raise exception 'Not permitted' using errcode = '42501'; end if;
  update post_show_reports set status = 'accepted', accepted_by = auth.uid(), accepted_at = now() where id = r.id;
  perform log_audit(r.org_id, 'post_show.accepted', 'source', r.source_id, '{}'::jsonb);
end $$;

-- ===========================================================================
-- Grants
-- ===========================================================================
grant execute on function public.update_show_settings(uuid, text, boolean, boolean, boolean) to authenticated;
grant execute on function public.map_speaker(uuid, text, uuid) to authenticated;
grant execute on function public.export_person_data(uuid) to authenticated;
grant execute on function public.anonymise_person(uuid, text) to authenticated;
grant execute on function public.owner_approve_brief(uuid, text) to authenticated;
grant execute on function public.set_contribution(text, uuid, uuid, text, boolean, text) to authenticated;
grant execute on function public.review_recall_flag(uuid, text) to authenticated;
grant execute on function public.confirm_promise(uuid, date, uuid, uuid, uuid) to authenticated;
grant execute on function public.dismiss_promise(uuid, text) to authenticated;
grant execute on function public.resolve_promise(uuid, text, text, uuid, int, uuid) to authenticated;
grant execute on function public.request_web_research(uuid, text, text, uuid) to authenticated;
grant execute on function public.review_finding(uuid, text, uuid) to authenticated;
grant execute on function public.compute_airtime(uuid) to authenticated;
grant execute on function public.submit_metric(uuid, uuid, text, numeric, text, text, text, text, text, text, text, text, uuid, text) to authenticated;
grant execute on function public.review_metric(uuid, boolean, text) to authenticated;
grant execute on function public.export_brief_package(uuid) to authenticated;
grant execute on function public.recall_search(uuid, text, uuid, uuid, date, date, int, uuid) to authenticated;
grant execute on function public.build_guest_prep(uuid, uuid) to authenticated;
grant execute on function public.accept_post_show_report(uuid) to authenticated;
grant select on public.promise_board, public.approved_person_metrics to authenticated;
