import { createRootRoute, createRoute, createRouter, Outlet } from '@tanstack/react-router';
import { Layout } from './components/Layout';
import { AdminPage } from './pages/Admin';
import { BriefsPage } from './pages/Briefs';
import { BriefWorkspace } from './pages/BriefWorkspace';
import { HomePage } from './pages/Home';
import { LoginPage, OnboardingPage } from './pages/Auth';
import { ReviewsPage } from './pages/Reviews';
import { ShowProfilePage } from './pages/ShowProfile';
import { SourceDetailPage } from './pages/SourceDetail';
import { SourcesPage } from './pages/Sources';
import { PeoplePage, PersonPage } from './pages/People';
import { PromisesPage } from './pages/Promises';
import { InventoryPage, MetricsPage, NotificationsPage, RecallPage } from './pages/Insights';
import { INSTALLED_MODULES } from './modules/registry';

const root = createRootRoute({ component: () => <Outlet /> });
const login = createRoute({ getParentRoute: () => root, path: '/login', component: LoginPage });
const onboarding = createRoute({ getParentRoute: () => root, path: '/onboarding', component: OnboardingPage });
const app = createRoute({ getParentRoute: () => root, id: 'app', component: Layout });

const home = createRoute({ getParentRoute: () => app, path: '/', component: HomePage });
const admin = createRoute({ getParentRoute: () => app, path: '/admin', component: AdminPage });
const showProfile = createRoute({ getParentRoute: () => app, path: '/shows/$showId', component: ShowProfilePage });
const sources = createRoute({ getParentRoute: () => app, path: '/sources', component: SourcesPage });
const sourceDetail = createRoute({ getParentRoute: () => app, path: '/sources/$sourceId', component: SourceDetailPage });
const briefs = createRoute({ getParentRoute: () => app, path: '/briefs', component: BriefsPage });
const brief = createRoute({ getParentRoute: () => app, path: '/briefs/$briefId', component: BriefWorkspace });
const reviews = createRoute({ getParentRoute: () => app, path: '/reviews', component: ReviewsPage });
const people = createRoute({ getParentRoute: () => app, path: '/people', component: PeoplePage });
const person = createRoute({ getParentRoute: () => app, path: '/people/$personId', component: PersonPage });
const promises = createRoute({ getParentRoute: () => app, path: '/promises', component: PromisesPage });
const recall = createRoute({ getParentRoute: () => app, path: '/recall', component: RecallPage });
const metrics = createRoute({ getParentRoute: () => app, path: '/scorecards', component: MetricsPage });
const inventory = createRoute({ getParentRoute: () => app, path: '/inventory', component: InventoryPage });
const notifications = createRoute({ getParentRoute: () => app, path: '/notifications', component: NotificationsPage });

const routeTree = root.addChildren([
  login, onboarding,
  app.addChildren([
    home, admin, showProfile, sources, sourceDetail, briefs, brief, reviews, people, person, promises, recall, metrics, inventory, notifications,
    // Installed modules add their own pages; they show a notice if the module is not licensed.
    ...INSTALLED_MODULES.flatMap((m) => m.routes?.(app) ?? []),
  ]),
]);

export const router = createRouter({ routeTree, defaultPreload: 'intent' });

declare module '@tanstack/react-router' {
  interface Register { router: typeof router }
}
