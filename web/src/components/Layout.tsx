import { Link, Navigate, Outlet, useRouterState } from '@tanstack/react-router';
import { BarChart3, Bell, BookOpenCheck, FileAudio, Handshake, Inbox, LayoutList, LogOut, Radio, Search, Settings2, Users } from 'lucide-react';
import { useNotifications } from '../pages/Insights';
import { useOrg } from '../lib/org';
import { configured, supabase } from '../lib/supabase';
import { Spinner } from './ui';

const NAV = [
  { to: '/', label: 'Overview', icon: Radio, exact: true },
  { to: '/sources', label: 'Sources', icon: FileAudio },
  { to: '/briefs', label: 'Briefs', icon: LayoutList },
  { to: '/reviews', label: 'Review inbox', icon: Inbox },
  { to: '/recall', label: 'Archive recall', icon: Search },
  { to: '/promises', label: 'Promises', icon: BookOpenCheck },
  { to: '/people', label: 'People', icon: Users },
  { to: '/scorecards', label: 'Scorecards', icon: BarChart3 },
  { to: '/inventory', label: 'Approved inventory', icon: Handshake },
  { to: '/notifications', label: 'Notifications', icon: Bell },
  { to: '/admin', label: 'Organisation', icon: Settings2 },
] as const;
// Commercial-only members are kept behind the editorial wall: approved inventory and their notifications only.
const COMMERCIAL_NAV = new Set<string>(['/inventory', '/notifications']);

export function Layout() {
  const { session, loading, org, orgs, switchOrg, shows, brands, memberships } = useOrg();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const notes = useNotifications();
  const unread = (notes.data ?? []).filter((n) => !n.read_at).length;
  const commercialOnly = memberships.length > 0 && memberships.every((m) => m.role === 'commercial');
  const nav = commercialOnly ? NAV.filter((n) => COMMERCIAL_NAV.has(n.to)) : NAV;

  if (!configured) return <SetupNeeded />;
  if (loading) return <div className="p-8"><Spinner /></div>;
  if (!session) return <Navigate to="/login" />;
  if (!org) return <Navigate to="/onboarding" />;

  return (
    <div className="min-h-full md:grid md:grid-cols-[232px_1fr]">
      <aside className="bg-rail text-white md:min-h-screen md:sticky md:top-0 md:h-screen flex md:flex-col">
        <div className="px-5 py-5 hidden md:block">
          <p className="text-[19px] font-bold tracking-[-0.02em]">Orb.IT</p>
          <p className="text-[12px] text-white/55">by ctrl.IT</p>
        </div>
        {orgs.length > 1 ? (
          <select className="hidden md:block mx-5 mb-4 bg-white/10 text-white text-sm rounded px-2 py-1" aria-label="Organisation"
            value={org.id} onChange={(e) => switchOrg(e.target.value)}>
            {orgs.map((o) => <option key={o.id} value={o.id} className="text-ink">{o.name}</option>)}
          </select>
        ) : <p className="hidden md:block px-5 pb-4 text-sm text-white/80 font-medium">{org.name}</p>}
        <nav className="flex md:flex-col gap-0.5 px-2 py-2 md:py-0 overflow-x-auto flex-1">
          {nav.map(({ to, label, icon: Icon, ...rest }) => {
            const active = 'exact' in rest ? path === to : path.startsWith(to);
            return (
              <Link key={to} to={to}
                className={`flex items-center gap-2.5 px-3 py-2 rounded-md text-[14px] whitespace-nowrap ${active ? 'bg-white text-ink font-semibold' : 'text-white/80 hover:bg-white/10'}`}>
                <Icon size={16} aria-hidden /> {label}
                {to === '/notifications' && unread > 0 && <span className="ml-auto text-[11px] font-bold rounded-full px-1.5 bg-blocked text-white">{unread}</span>}
              </Link>
            );
          })}
        </nav>
        <div className="hidden md:block px-5 py-4 border-t border-white/10 text-[12px] text-white/60">
          <p>{brands.length} brands · {shows.length} shows</p>
          <p className="truncate mt-1" title={session.user.email}>{session.user.email}</p>
          <button onClick={() => supabase.auth.signOut()} className="mt-2 inline-flex items-center gap-1.5 text-white/80 hover:text-white">
            <LogOut size={14} aria-hidden /> Sign out
          </button>
        </div>
      </aside>
      <main className="min-w-0 px-4 md:px-10 py-8 max-w-[1440px]">
        {commercialOnly && !COMMERCIAL_NAV.has(path) ? <Navigate to="/inventory" /> : <Outlet />}
      </main>
    </div>
  );
}

function SetupNeeded() {
  return (
    <div className="max-w-[640px] mx-auto p-10">
      <h1 className="text-2xl font-semibold">Connect Orb.IT to Supabase</h1>
      <p className="mt-3 text-ink-soft">
        Copy <code>web/.env.example</code> to <code>web/.env.local</code>, add your project URL and anon key, then restart the dev server.
        The README explains how to apply the database migrations.
      </p>
    </div>
  );
}
