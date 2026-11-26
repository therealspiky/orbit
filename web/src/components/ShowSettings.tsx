import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ErrorNote, Field } from './ui';
import { useOrg } from '../lib/org';
import { check, supabase } from '../lib/supabase';
import { EDITOR_ROLES } from '../lib/types';

interface ShowPolicy {
  id: string; org_id: string; brand_id: string; editorial_category: string; owner_approval_required: boolean;
  exclude_from_commercial_matching: boolean; cross_show_recommendation_opt_in: boolean;
}
interface Season { id: string; name: string; number: number | null; starts_on: string | null; ends_on: string | null; status: string }

const CATEGORY: Record<string, string> = {
  entertainment: 'Entertainment', lifestyle: 'Lifestyle', news: 'News', current_affairs: 'Current affairs', sport: 'Sport', other: 'Other',
};

/** Show policy (owner approval, commercial opt-out, cross-show recommendations) and seasons (spec §6.1). */
export function ShowSettings({ showId }: { showId: string }) {
  const { can, refresh } = useOrg();
  const show = useQuery({
    queryKey: ['show-policy', showId],
    queryFn: async () => check(await supabase.from('shows').select('id,org_id,brand_id,editorial_category,owner_approval_required,exclude_from_commercial_matching,cross_show_recommendation_opt_in').eq('id', showId).single()) as ShowPolicy,
  });
  const seasons = useQuery({
    queryKey: ['seasons', showId],
    queryFn: async () => check(await supabase.from('seasons').select('*').eq('show_id', showId).order('starts_on', { ascending: false, nullsFirst: false })) as Season[],
  });
  const [p, setP] = useState<ShowPolicy | null>(null);
  const cur = p ?? show.data ?? null;
  const save = useMutation({
    mutationFn: async () => check(await supabase.rpc('update_show_settings', {
      p_show: showId, p_category: cur!.editorial_category, p_owner_approval: cur!.owner_approval_required,
      p_exclude_commercial: cur!.exclude_from_commercial_matching, p_opt_in: cur!.cross_show_recommendation_opt_in,
    })),
    onSuccess: () => { setP(null); void show.refetch(); refresh(); },
  });
  const [ns, setNs] = useState({ name: '', starts_on: '', ends_on: '' });
  const addSeason = useMutation({
    mutationFn: async () => check(await supabase.from('seasons').insert({
      org_id: cur!.org_id, brand_id: cur!.brand_id, show_id: showId, name: ns.name.trim(),
      starts_on: ns.starts_on || null, ends_on: ns.ends_on || null, status: 'active',
    })),
    onSuccess: () => { setNs({ name: '', starts_on: '', ends_on: '' }); void seasons.refetch(); },
  });
  if (!cur) return null;
  const isOwner = can(['org_admin', 'brand_editor'], cur.brand_id, null);
  const canSeason = can([...EDITOR_ROLES, 'producer'], cur.brand_id, showId);

  return (
    <div className="grid gap-6 md:grid-cols-2 mt-8">
      <section className="panel p-4 text-sm space-y-3">
        <h2 className="text-lg font-semibold">Show policy</h2>
        <fieldset disabled={!isOwner} className="space-y-3">
          <Field label="Editorial category" help="News and current affairs start with owner approval on and sponsorship matching off.">
            <select className="field-input" value={cur.editorial_category} onChange={(e) => setP({ ...cur, editorial_category: e.target.value })}>
              {Object.entries(CATEGORY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
          <label className="flex gap-2"><input type="checkbox" checked={cur.owner_approval_required} onChange={(e) => setP({ ...cur, owner_approval_required: e.target.checked })} />
            Brand owner must give final approval before export</label>
          <label className="flex gap-2"><input type="checkbox" checked={cur.exclude_from_commercial_matching} onChange={(e) => setP({ ...cur, exclude_from_commercial_matching: e.target.checked })} />
            Keep out of sponsorship matching</label>
          <label className="flex gap-2"><input type="checkbox" checked={cur.cross_show_recommendation_opt_in} onChange={(e) => setP({ ...cur, cross_show_recommendation_opt_in: e.target.checked })} />
            Receive briefs from other shows' sources</label>
        </fieldset>
        {isOwner ? <button className="btn btn-primary" disabled={!p || save.isPending} onClick={() => save.mutate()}>Save policy</button>
          : <p className="text-[12px] text-ink-faint">Only the brand owner or an administrator can change these.</p>}
        <ErrorNote error={save.error} />
      </section>
      <section className="panel p-4 text-sm">
        <h2 className="text-lg font-semibold mb-2">Seasons</h2>
        {seasons.data?.length ? (
          <ul className="divide-y divide-line mb-3">
            {seasons.data.map((s) => <li key={s.id} className="py-1.5 flex justify-between gap-2"><span className="font-semibold">{s.name}</span>
              <span className="text-ink-faint">{[s.starts_on, s.ends_on].filter(Boolean).join(' to ') || 'No dates'} · {s.status}</span></li>)}
          </ul>
        ) : <p className="text-ink-faint mb-3">No seasons. Episodes can sit directly under the show.</p>}
        {canSeason && (
          <form className="grid gap-2 grid-cols-[2fr_1fr_1fr_auto] items-end" onSubmit={(e) => { e.preventDefault(); if (ns.name.trim()) addSeason.mutate(); }}>
            <input className="field-input" placeholder="e.g. Season 3" aria-label="Season name" value={ns.name} onChange={(e) => setNs({ ...ns, name: e.target.value })} />
            <input className="field-input" type="date" aria-label="Starts" value={ns.starts_on} onChange={(e) => setNs({ ...ns, starts_on: e.target.value })} />
            <input className="field-input" type="date" aria-label="Ends" value={ns.ends_on} onChange={(e) => setNs({ ...ns, ends_on: e.target.value })} />
            <button className="btn btn-quiet" disabled={!ns.name.trim() || addSeason.isPending}>Add</button>
          </form>
        )}
        <ErrorNote error={addSeason.error} />
      </section>
    </div>
  );
}
