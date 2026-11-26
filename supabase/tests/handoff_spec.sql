-- Handoff spec (26 Nov 2026) database tests: sales wall (G6), metrics (G5), recall isolation (G7),
-- contradiction flags (G4), web findings gate (US-044), promises (US-043), clips (US-030),
-- owner approval + export gate (US-031/032), credit ledger (US-050), people and speakers (US-013).
-- Runs after security_and_workflow.sql and reuses its fixtures (t_ids, users A-E).
\set ON_ERROR_STOP 1

-- Users: A admin, B producer (Hitz Morning), C show editor (Hitz Morning), D other org, E commercial.
insert into auth.users (id, email) values ('00000000-0000-0000-0000-00000000000f', 'owner@orbit.test');
begin;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', true);
set local role authenticated;
select public.add_member((select v from t_ids where k='org'), 'owner@orbit.test', 'brand_editor', (select v from t_ids where k='hitz'), null);
reset role;
commit;

-- A fresh brief on Hitz Morning, sourced from the org-shared Joy Prime recording.
insert into briefs (org_id, brand_id, show_id, origin_source_id, title, status, created_by)
select (select v from t_ids where k='org'), (select v from t_ids where k='hitz'), (select v from t_ids where k='hitz_morning'),
       (select v from t_ids where k='src_shared'), 'Would You Stay If Your Partner Cheated?', 'drafted',
       '00000000-0000-0000-0000-00000000000b';
insert into t_ids select 'brief2', id from briefs where title like 'Would You Stay%';
insert into brief_versions (org_id, brand_id, show_id, brief_id, version, content, profile_version_id, generated, model)
select org_id, brand_id, show_id, id, 1, '{"title":"Would You Stay?","recommendation":"proceed","review_flags":[]}'::jsonb,
       (select v from t_ids where k='hitz_profile_v1'), true, 'test'
from briefs where id = (select v from t_ids where k='brief2');
update briefs set current_version_id = (select id from brief_versions where brief_id = (select v from t_ids where k='brief2'))
 where id = (select v from t_ids where k='brief2');
update sources set storage_path = (select v from t_ids where k='org') || '/' || (select v from t_ids where k='src_shared') || '/x.mp4'
 where id = (select v from t_ids where k='src_shared');

-- Sales wall ----------------------------------------------------------------
do $$ begin
  perform pg_temp.ok(pg_temp.count_as('00000000-0000-0000-0000-00000000000e', 'select * from sources') = 0,
    'sales cannot list any source, even organisation-shared ones');
  perform pg_temp.ok(pg_temp.count_as('00000000-0000-0000-0000-00000000000e', 'select * from transcript_segments') = 0,
    'sales cannot read raw transcripts');
  perform pg_temp.ok(pg_temp.count_as('00000000-0000-0000-0000-00000000000e',
    format('select * from briefs where id = %L', (select v from t_ids where k='brief2'))) = 0,
    'sales cannot read a draft brief (G6)');
  perform pg_temp.ok(pg_temp.count_as('00000000-0000-0000-0000-00000000000e', 'select * from brief_versions') = 0,
    'sales cannot read brief drafts or versions');
  perform pg_temp.ok(pg_temp.count_as('00000000-0000-0000-0000-00000000000e', 'select * from people') = 0,
    'sales cannot read the people directory');
  perform pg_temp.ok(pg_temp.count_as('00000000-0000-0000-0000-00000000000b',
    format('select * from briefs where id = %L', (select v from t_ids where k='brief2'))) = 1,
    'the producer still reads the draft');
end $$;

-- People and speaker identity ------------------------------------------------
insert into people (org_id, display_name, kind, created_by)
values ((select v from t_ids where k='org'), 'Hon. Esi Darko (sample)', 'guest', '00000000-0000-0000-0000-00000000000a');
insert into t_ids select 'guest', id from people where display_name like 'Hon. Esi Darko%';
insert into people (id, org_id, display_name, kind) values ('55555555-5555-5555-5555-555555555555', '99999999-9999-9999-9999-999999999999', 'Other org person', 'guest');
do $$ begin
  perform pg_temp.ok(pg_temp.count_as('00000000-0000-0000-0000-00000000000d', 'select * from people') = 1,
    'people are tenant-scoped');
  perform pg_temp.ok(pg_temp.fails_as('00000000-0000-0000-0000-00000000000d',
    format($q$select public.map_speaker(%L, 'SPEAKER_1', %L)$q$, (select v from t_ids where k='src_shared'), (select v from t_ids where k='guest'))),
    'an outsider cannot map speakers');
  perform pg_temp.ok(pg_temp.fails_as('00000000-0000-0000-0000-00000000000a',
    format($q$select public.map_speaker(%L, 'SPEAKER_1', '55555555-5555-5555-5555-555555555555')$q$,
      (select v from t_ids where k='src_shared'))),
    'a speaker cannot be mapped to another organisation''s person');
  perform pg_temp.ok(not pg_temp.fails_as('00000000-0000-0000-0000-00000000000a',
    format($q$select public.map_speaker(%L, 'SPEAKER_1', %L)$q$, (select v from t_ids where k='src_shared'), (select v from t_ids where k='guest'))),
    'admin maps SPEAKER_1 to the guest');
  perform pg_temp.ok((select count(*) from transcript_segments where source_id = (select v from t_ids where k='src_shared')
                      and person_id = (select v from t_ids where k='guest')) = 5,
    'mapping is retroactive across the source');
end $$;

-- Archive Recall: tenant isolation and permissions (G7) ----------------------
insert into brands (id, org_id, name) values ('44444444-4444-4444-4444-444444444444', '99999999-9999-9999-9999-999999999999', 'Other FM');
insert into sources (id, org_id, brand_id, kind, title, share_scope, status, timestamps_genuine)
values ('88888888-8888-8888-8888-888888888888', '99999999-9999-9999-9999-999999999999', '44444444-4444-4444-4444-444444444444',
        'transcript', 'Other org', 'organisation', 'ready', true);
insert into transcript_segments (org_id, source_id, idx, start_ms, end_ms, text)
values ('99999999-9999-9999-9999-999999999999', '88888888-8888-8888-8888-888888888888', 0, 0, 1000, 'Segment about trust and money in another group.');
do $$ begin
  perform pg_temp.ok(pg_temp.count_as('00000000-0000-0000-0000-00000000000a',
    format($q$select * from public.recall_search(%L, 'trust money')$q$, (select v from t_ids where k='org'))) = 9,
    'topic recall finds the matching segments (corrected text, not the raw version)');
  perform pg_temp.ok(pg_temp.count_as('00000000-0000-0000-0000-00000000000a',
    format($q$select * from public.recall_search(%L, 'trust money') where source_id = '88888888-8888-8888-8888-888888888888'$q$,
      (select v from t_ids where k='org'))) = 0,
    'recall never returns another tenant''s similar text (G7)');
  perform pg_temp.ok(pg_temp.count_as('00000000-0000-0000-0000-00000000000a',
    $q$select * from public.recall_search('99999999-9999-9999-9999-999999999999', 'trust money')$q$) = 0,
    'recall refuses an organisation the caller does not belong to');
  perform pg_temp.ok(pg_temp.count_as('00000000-0000-0000-0000-00000000000e',
    format($q$select * from public.recall_search(%L, 'trust money')$q$, (select v from t_ids where k='org'))) = 0,
    'sales cannot run archive recall');
  perform pg_temp.ok(pg_temp.count_as('00000000-0000-0000-0000-00000000000b',
    format($q$select * from public.recall_search(%L, 'off record')$q$, (select v from t_ids where k='org'))) = 0,
    'recall respects show-restricted sources');
  perform pg_temp.ok(pg_temp.count_as('00000000-0000-0000-0000-00000000000a',
    format($q$select * from public.recall_search(%L, null, %L)$q$, (select v from t_ids where k='org'), (select v from t_ids where k='guest'))) = 5,
    'person recall returns that person''s statements');
end $$;

-- Guest prep: empty archive gives an empty sheet, never filler
insert into people (org_id, display_name, kind) values ((select v from t_ids where k='org'), 'New guest (sample)', 'guest');
do $$
declare v_sheet uuid;
begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', true);
  execute 'set local role authenticated';
  v_sheet := public.build_guest_prep((select id from people where display_name = 'New guest (sample)'));
  execute 'reset role';
  perform pg_temp.ok((select (content->>'empty')::boolean and jsonb_array_length(content->'quotes') = 0 from guest_prep_sheets where id = v_sheet),
    'guest with no archive gets an empty prep sheet');
end $$;

-- Recall flags: contradictions need two citations (G4) -----------------------
do $$ begin
  perform pg_temp.ok(pg_temp.fails_as('00000000-0000-0000-0000-00000000000a', 'select 1') = false, 'harness sanity');
  begin
    insert into recall_flags (org_id, source_id, kind, summary, citations, fingerprint)
    values ((select v from t_ids where k='org'), (select v from t_ids where k='src_shared'), 'contradiction_candidate',
            'Possible tension — review', jsonb_build_array(jsonb_build_object('source_id', (select v from t_ids where k='src_shared'), 'idx', 1)), 'c1');
    raise exception 'FAIL: single-citation contradiction accepted';
  exception when check_violation then
    raise notice 'ok - a contradiction flag needs two citations';
  end;
end $$;

-- Promises ------------------------------------------------------------------
insert into promises (org_id, brand_id, show_id, source_id, segment_start, segment_end, start_ms, end_ms, verbatim_text, person_id, due_phrase, fingerprint)
select (select v from t_ids where k='org'), (select v from t_ids where k='joy'), (select v from t_ids where k='tys'),
       (select v from t_ids where k='src_shared'), 3, 3, 30000, 39000, 'Segment 3 text about trust and money.',
       (select v from t_ids where k='guest'), 'by Friday', 'p1';
insert into t_ids select 'promise', id from promises where fingerprint = 'p1';
do $$ begin
  perform pg_temp.ok(pg_temp.fails_as('00000000-0000-0000-0000-00000000000b',
    format($q$select public.confirm_promise(%L, current_date + 2)$q$, (select v from t_ids where k='promise'))),
    'a producer outside the source show cannot confirm its promises');
  perform pg_temp.ok(pg_temp.fails_as('00000000-0000-0000-0000-00000000000a',
    format($q$select public.confirm_promise(%L, null)$q$, (select v from t_ids where k='promise'))),
    'confirmation needs a due date');
  perform pg_temp.ok(not pg_temp.fails_as('00000000-0000-0000-0000-00000000000a',
    format($q$select public.confirm_promise(%L, current_date + 1, '00000000-0000-0000-0000-00000000000b')$q$, (select v from t_ids where k='promise'))),
    'admin confirms the promise and assigns the Hitz producer');
  perform pg_temp.ok(public.run_promise_nudges() = 1, 'a nudge is sent the day before it is due');
  perform pg_temp.ok(public.run_promise_nudges() = 0, 'nudges are idempotent');
  perform pg_temp.ok(public.run_promise_nudges(current_date + 3) = 1, 'an overdue nudge follows');
  perform pg_temp.ok(pg_temp.count_as('00000000-0000-0000-0000-00000000000b',
    $q$select * from notifications where kind = 'promise'$q$) = 3, 'assignee received assignment, upcoming and overdue notices');
  perform pg_temp.ok(pg_temp.count_as('00000000-0000-0000-0000-00000000000a', 'select * from promise_board where is_overdue') = 0,
    'not overdue before the due date');
  update promises set due_on = current_date - 1 where id = (select v from t_ids where k='promise');
  perform pg_temp.ok(pg_temp.count_as('00000000-0000-0000-0000-00000000000a', 'select * from promise_board where is_overdue') = 1,
    'promise board computes overdue');
  perform pg_temp.ok(pg_temp.fails_as('00000000-0000-0000-0000-00000000000a',
    format($q$select public.resolve_promise(%L, 'fulfilled', '')$q$, (select v from t_ids where k='promise'))),
    'fulfilment needs evidence');
  perform pg_temp.ok(not pg_temp.fails_as('00000000-0000-0000-0000-00000000000a',
    format($q$select public.resolve_promise(%L, 'broken', 'Road still flooded on follow-up', %L, 4)$q$,
      (select v from t_ids where k='promise'), (select v from t_ids where k='src_shared'))),
    'a promise is marked broken with a cited later segment');
end $$;

-- A transcript correction reaches open promise quotes (they always quote the transcript as it stands)
insert into promises (org_id, brand_id, show_id, source_id, segment_start, segment_end, start_ms, end_ms, verbatim_text, due_phrase, fingerprint)
select (select v from t_ids where k='org'), (select v from t_ids where k='joy'), (select v from t_ids where k='tys'),
       (select v from t_ids where k='src_shared'), 5, 5, 50000, 59000, 'We will fix a saffo road', 'by Friday', 'p2';
do $$ begin
  update transcript_segments set text = 'We will fix Asafo road by Friday.'
   where source_id = (select v from t_ids where k='src_shared') and idx = 5;
  perform pg_temp.ok((select verbatim_text from promises where fingerprint = 'p2') = 'We will fix Asafo road by Friday.',
    'a corrected passage updates the open promise quote');
  perform pg_temp.ok(exists (select 1 from audit_events where action = 'promise.quote_corrected'), 'the quote correction is audited');
end $$;

-- Web findings: external, editor-gated (US-044) ------------------------------
insert into web_research_queries (id, org_id, query_text, context_type, context_id, brief_id, status)
values ('77777777-7777-7777-7777-777777777777', (select v from t_ids where k='org'), 'Asafo Road drains', 'brief',
        (select v from t_ids where k='brief2'), (select v from t_ids where k='brief2'), 'done');
insert into external_findings (id, org_id, query_id, url, publisher, title, excerpt)
values ('66666666-6666-6666-6666-666666666666', (select v from t_ids where k='org'), '77777777-7777-7777-7777-777777777777',
        'https://example.org/news/drains', 'example.org', 'Assembly announces delay', 'The assembly announced a delay.');
do $$ begin
  perform pg_temp.ok((select label from external_findings where id = '66666666-6666-6666-6666-666666666666')
    = 'External source — not an Orb.IT archive quote', 'findings carry the fixed external label');
  perform pg_temp.ok((select published_on from external_findings where id = '66666666-6666-6666-6666-666666666666') is null,
    'unknown publication date stays unknown');
  perform pg_temp.ok(pg_temp.fails_as('00000000-0000-0000-0000-00000000000b',
    format($q$select public.review_finding('66666666-6666-6666-6666-666666666666', 'confirmed_for_use', %L)$q$, (select v from t_ids where k='brief2'))),
    'a producer cannot confirm a web finding');
  perform pg_temp.ok(pg_temp.count_as('00000000-0000-0000-0000-00000000000e', 'select * from external_findings') = 0,
    'sales cannot see web findings');
  perform pg_temp.ok(pg_temp.fails_as('00000000-0000-0000-0000-00000000000a',
    $q$update external_findings set label = 'Archive quote' where id = '66666666-6666-6666-6666-666666666666'$q$)
    or (select label from external_findings where id = '66666666-6666-6666-6666-666666666666') = 'External source — not an Orb.IT archive quote',
    'a finding can never be relabelled as archive (G3)');
  perform pg_temp.ok(not pg_temp.fails_as('00000000-0000-0000-0000-00000000000c',
    format($q$select public.review_finding('66666666-6666-6666-6666-666666666666', 'confirmed_for_use', %L)$q$, (select v from t_ids where k='brief2'))),
    'the show editor confirms the finding for this brief');
end $$;

-- Clips ---------------------------------------------------------------------
do $$
declare c uuid;
begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', true);
  execute 'set local role authenticated';
  c := public.create_clip((select v from t_ids where k='brief2'), 2, 3, '9:16', 'Hook');
  execute 'reset role';
  insert into t_ids values ('clip', c);
  perform pg_temp.ok((select start_ms = 20000 and end_ms = 39000 and not caption_differs from clips where id = c),
    'clip times and captions come from the transcript');
  perform pg_temp.ok(pg_temp.fails_as('00000000-0000-0000-0000-00000000000b',
    format($q$select public.create_clip(%L, 2, 40)$q$, (select v from t_ids where k='brief2'))),
    'clips cannot reach past the transcript');
  perform pg_temp.ok(not pg_temp.fails_as('00000000-0000-0000-0000-00000000000b',
    format($q$select public.update_clip(%L, 'Hook', 'Something nobody said.')$q$, c)),
    'producer edits the caption');
  perform pg_temp.ok((select caption_differs from clips where id = c), 'edited captions are flagged as differing from the transcript');
  perform pg_temp.ok(pg_temp.fails_as('00000000-0000-0000-0000-00000000000b',
    format($q$select public.update_clip(%L, 'She said the opposite in March', null)$q$, c)),
    'G4: clip copy cannot carry said-the-opposite wording');
  perform pg_temp.ok(not pg_temp.fails_as('00000000-0000-0000-0000-00000000000b', format('select public.request_clip_render(%L)', c)),
    'producer requests a render');
  perform pg_temp.ok((select count(*) from jobs where kind = 'render_clip' and payload->>'clip_id' = c::text) = 1, 'render job queued');
  perform pg_temp.ok(pg_temp.count_as('00000000-0000-0000-0000-00000000000e', 'select * from clips') = 0, 'sales cannot see draft clips');
  perform pg_temp.ok(pg_temp.count_as('00000000-0000-0000-0000-00000000000d', 'select * from clips') = 0, 'outsiders cannot see clips');
end $$;

-- Credits, owner approval and the export gate --------------------------------
do $$ begin
  perform pg_temp.ok((select count(*) from contributions where object_id = (select v from t_ids where k='brief2')
                      and role in ('sourced', 'produced')) >= 1, 'credits are written from workflow actions');
  perform pg_temp.ok(pg_temp.fails_as('00000000-0000-0000-0000-00000000000b',
    format('select public.export_brief_package(%L)', (select v from t_ids where k='brief2'))),
    'a draft cannot be exported');
  update briefs set status = 'approved' where id = (select v from t_ids where k='brief2');
  perform pg_temp.ok(public.owner_approval_needed((select v from t_ids where k='brief2')),
    'a brief using a confirmed web finding needs owner approval');
  perform pg_temp.ok(pg_temp.fails_as('00000000-0000-0000-0000-00000000000b',
    format('select public.export_brief_package(%L)', (select v from t_ids where k='brief2'))),
    'export is blocked until the owner approves');
  perform pg_temp.ok(pg_temp.fails_as('00000000-0000-0000-0000-00000000000c',
    format('select public.owner_approve_brief(%L)', (select v from t_ids where k='brief2'))),
    'a show editor is not the owner');
  perform pg_temp.ok(not pg_temp.fails_as('00000000-0000-0000-0000-00000000000f',
    format('select public.owner_approve_brief(%L)', (select v from t_ids where k='brief2'))),
    'the brand owner gives final approval');
  update sources set twi_beta = true where id = (select origin_source_id from briefs where id = (select v from t_ids where k='brief2'));
  perform pg_temp.ok(pg_temp.fails_as('00000000-0000-0000-0000-00000000000b',
    format('select public.export_brief_package(%L)', (select v from t_ids where k='brief2'))),
    'G8: a Twi-beta citation blocks export until a language review passes');
  update sources set twi_beta = false where id = (select origin_source_id from briefs where id = (select v from t_ids where k='brief2'));
  perform pg_temp.ok(not pg_temp.fails_as('00000000-0000-0000-0000-00000000000b',
    format('select public.export_brief_package(%L)', (select v from t_ids where k='brief2'))),
    'the approved package exports');
  perform pg_temp.ok((select bool_and(locked_at is not null) from contributions where object_id = (select v from t_ids where k='brief2')),
    'credits lock on export');
  perform pg_temp.ok(pg_temp.count_as('00000000-0000-0000-0000-00000000000e',
    format('select * from briefs where id = %L', (select v from t_ids where k='brief2'))) = 1,
    'sales can see the brief once it is approved inventory');
  perform pg_temp.ok(pg_temp.count_as('00000000-0000-0000-0000-00000000000e', 'select * from brief_versions') = 0,
    'but still not its editorial drafts');
end $$;

-- Metrics: evidence and approval (US-051, G5) --------------------------------
insert into episodes (org_id, brand_id, show_id, title) values
  ((select v from t_ids where k='org'), (select v from t_ids where k='joy'), (select v from t_ids where k='tys'), 'TYS ep 1');
insert into t_ids select 'ep', id from episodes where title = 'TYS ep 1';
update sources set episode_id = (select v from t_ids where k='ep') where id = (select v from t_ids where k='src_shared');
insert into episode_credits (org_id, episode_id, person_id, credit_role)
values ((select v from t_ids where k='org'), (select v from t_ids where k='ep'), (select v from t_ids where k='guest'), 'presenter');
do $$
declare m uuid;
begin
  perform pg_temp.ok(pg_temp.fails_as('00000000-0000-0000-0000-00000000000a',
    format($q$select public.submit_metric(%L, null, 'reach', 1000, 'views', 'youtube', 'manual_entry', null, null, 'from studio')$q$,
      (select v from t_ids where k='ep'))),
    'a figure without evidence cannot be submitted');
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', true);
  execute 'set local role authenticated';
  m := public.submit_metric((select v from t_ids where k='ep'), null, 'reach', 1000, 'views', 'youtube', 'manual_entry',
                            'https://studio.example/report.png', null, 'YouTube Studio screenshot');
  perform public.compute_airtime((select v from t_ids where k='ep'));
  execute 'reset role';
  perform pg_temp.ok((select count(*) from metric_observations where metric_type = 'airtime_ms' and status = 'pending_approval'
                      and airtime_computation_id is not null) = 1, 'airtime is computed from the transcript and awaits confirmation');
  perform pg_temp.ok(pg_temp.count_as('00000000-0000-0000-0000-00000000000a', 'select * from approved_person_metrics') = 0,
    'nothing shows on dashboards before approval (G5)');
  perform pg_temp.ok(pg_temp.count_as('00000000-0000-0000-0000-00000000000e', 'select * from metric_observations') = 0,
    'sales never sees unapproved figures');
  update memberships set brand_id = brand_id where false;
  perform pg_temp.ok(pg_temp.fails_as('00000000-0000-0000-0000-00000000000c', format('select public.review_metric(%L, true)', m)),
    'a show editor cannot approve figures');
  perform pg_temp.ok(not pg_temp.fails_as('00000000-0000-0000-0000-00000000000a', format('select public.review_metric(%L, true)', m)),
    'the owner approves the figure');
  perform pg_temp.ok((select attribution_rule from approved_person_metrics where metric_id = m limit 1) like 'Split equally among 1 %',
    'approved figure is attributed with the visible equal-split rule');
end $$;

-- Audit and approval records are immutable ----------------------------------
do $$ begin
  perform pg_temp.ok(pg_temp.fails_as('00000000-0000-0000-0000-00000000000a', 'delete from audit_events')
    or (select count(*) from audit_events) > 0, 'audit events cannot be deleted');
  begin
    update approval_records set comment = 'edited';
    if (select count(*) from approval_records) > 0 then raise exception 'FAIL: approval record updated'; end if;
  exception when insufficient_privilege then raise notice 'ok - approval records are insert-only';
  end;
end $$;

\echo 'handoff spec tests complete'
