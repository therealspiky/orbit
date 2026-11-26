-- A transcript correction must reach promise quotes: a promise always quotes the transcript as it now stands.
-- When a cited passage is corrected and the stored quote no longer appears in it, the quote is replaced by
-- the corrected passage text (still verbatim) and the change is audited. Closed promises keep their record.
create or replace function public.promises_follow_correction() returns trigger
language plpgsql security definer set search_path = public as $$
declare p record; v_text text;
begin
  if new.text is not distinct from old.text then return new; end if;
  for p in select * from promises
            where source_id = new.source_id and new.idx between segment_start and segment_end
              and status in ('candidate', 'confirmed', 'nudge_sent') loop
    v_text := segment_range_text(p.source_id, p.segment_start, p.segment_end);
    if position(normalise_text(p.verbatim_text) in normalise_text(v_text)) = 0 then
      update promises set verbatim_text = left(trim(v_text), 600) where id = p.id;
      perform log_audit(p.org_id, 'promise.quote_corrected', 'promise', p.id,
        jsonb_build_object('segment', new.idx, 'old', p.verbatim_text));
    end if;
  end loop;
  return new;
end $$;
create trigger segments_promise_correction after update of text on public.transcript_segments
  for each row execute function public.promises_follow_correction();
