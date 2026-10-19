import { lazy, Suspense } from 'react';
import { createBrowserRouter, Navigate, Outlet, type RouteObject } from 'react-router-dom';
import ProtectedRoute from './components/ProtectedRoute';
import GuestRoute from './components/GuestRoute';
import AccountRoute from './components/AccountRoute';
import RouteErrorBoundary from './components/RouteErrorBoundary';
import AppShell from './components/shell/AppShell';
import HomePage from './pages/HomePage';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import OnboardingPage from './pages/OnboardingPage';
import SessionExpiredPage from './pages/SessionExpiredPage';
import ConnectionProblemPage from './pages/ConnectionProblemPage';
import ResetPasswordPage from './pages/ResetPasswordPage';
import MyGardensPage from './pages/MyGardensPage';
import SeedCataloguePage from './pages/SeedCataloguePage';
import PlantingGuidePage from './pages/PlantingGuidePage';
import HarvestLogPage from './pages/HarvestLogPage';
import HarvestPrintPage from './pages/HarvestPrintPage';
import DataMetricsPage from './pages/DataMetricsPage';
import ComparePage from './pages/ComparePage';
import SoilPage from './pages/SoilPage';
import WeatherPage from './pages/WeatherPage';
import AmendmentPage from './pages/AmendmentPage';
import AccountPage from './pages/AccountPage';
import EmailConfirmPage from './pages/EmailConfirmPage';
import VerifyEmailPage from './pages/VerifyEmailPage';
import RevertEmailPage from './pages/RevertEmailPage';
import AboutPage from './pages/AboutPage';
import NotFoundPage from './pages/NotFoundPage';
import AdminRoute from './components/admin/AdminRoute';
import AdminShell from './components/admin/AdminShell';

// Admin pages load on demand so they stay out of the main bundle.
const AdminSeedsPage = lazy(() => import('./pages/admin/SeedsPage'));
const AdminModerationPage = lazy(() => import('./pages/admin/ModerationPage'));
const AdminUsersPage = lazy(() => import('./pages/admin/UsersPage'));
const AdminFeaturesPage = lazy(() => import('./pages/admin/FeaturesPage'));
const AdminFeedbackPage = lazy(() => import('./pages/admin/FeedbackPage'));
const AdminSystemPage = lazy(() => import('./pages/admin/SystemPage'));

const withErrorBoundary = (route: RouteObject): RouteObject => ({ ...route, errorElement: <RouteErrorBoundary /> });

// Signed-in app pages. Each child keeps its own guard, so guards run inside the shell.
const shellRoutes: RouteObject[] = [
  {
    path: '/',
    element: (
      <ProtectedRoute requireOnboarding>
        <HomePage />
      </ProtectedRoute>
    ),
  },
  {
    path: '/gardens',
    element: (
      <ProtectedRoute>
        <MyGardensPage />
      </ProtectedRoute>
    ),
  },
  {
    path: '/catalogue',
    element: (
      <ProtectedRoute>
        <SeedCataloguePage />
      </ProtectedRoute>
    ),
  },
  {
    path: '/guide',
    element: (
      <ProtectedRoute>
        <PlantingGuidePage />
      </ProtectedRoute>
    ),
  },
  {
    path: '/about',
    element: (
      <ProtectedRoute>
        <AboutPage />
      </ProtectedRoute>
    ),
  },
  {
    // One route for the list and the detail so the page (and its loaded list)
    // stays mounted when an entry is opened.
    path: '/harvest/:entryId?',
    element: (
      <ProtectedRoute>
        <HarvestLogPage />
      </ProtectedRoute>
    ),
  },
  {
    path: '/data',
    element: (
      <AccountRoute>
        <DataMetricsPage />
      </AccountRoute>
    ),
  },
  {
    path: '/data/compare',
    element: (
      <AccountRoute>
        <ComparePage />
      </AccountRoute>
    ),
  },
  {
    path: '/account',
    element: (
      <AccountRoute>
        <AccountPage />
      </AccountRoute>
    ),
  },
  {
    path: '/garden/:gardenId/soil',
    element: (
      <AccountRoute>
        <SoilPage />
      </AccountRoute>
    ),
  },
  {
    path: '/garden/:gardenId/amendments',
    element: (
      <AccountRoute>
        <AmendmentPage />
      </AccountRoute>
    ),
  },
  {
    path: '/weather',
    element: (
      <AccountRoute>
        <WeatherPage />
      </AccountRoute>
    ),
  },
];

const routes: RouteObject[] = [
  {
    element: <AppShell />,
    children: shellRoutes.map(withErrorBoundary),
  },
  {
    // Admin dashboard: its own desktop layout, outside the app shell.
    path: '/admin',
    element: (
      <AdminRoute>
        <AdminShell />
      </AdminRoute>
    ),
    children: [
      {
        // Pathless layout: the shell stays up while a lazy page loads.
        element: (
          <Suspense fallback={<p style={{ margin: 0, color: 'var(--c-text-3)' }}>Loading…</p>}>
            <Outlet />
          </Suspense>
        ),
        children: [
          { index: true, element: <Navigate to="seeds" replace /> },
          { path: 'seeds', element: <AdminSeedsPage /> },
          { path: 'moderation', element: <AdminModerationPage /> },
          { path: 'users', element: <AdminUsersPage /> },
          { path: 'features', element: <AdminFeaturesPage /> },
          { path: 'feedback', element: <AdminFeedbackPage /> },
          { path: 'system', element: <AdminSystemPage /> },
        ].map(withErrorBoundary),
      },
    ],
  },
  {
    // Outside the shell: a bare printable page. The static "print" segment
    // outranks the shell's /harvest/:entryId? (flattened route ranking).
    path: '/harvest/print',
    element: (
      <ProtectedRoute>
        <HarvestPrintPage />
      </ProtectedRoute>
    ),
  },
  {
    path: '/onboarding',
    element: (
      <ProtectedRoute>
        <OnboardingPage />
      </ProtectedRoute>
    ),
  },
  {
    path: '/login',
    element: (
      <GuestRoute>
        <LoginPage />
      </GuestRoute>
    ),
  },
  {
    path: '/register',
    element: (
      <GuestRoute>
        <RegisterPage />
      </GuestRoute>
    ),
  },
  {
    path: '/session-expired',
    element: <SessionExpiredPage />,
  },
  {
    path: '/connection-problem',
    element: <ConnectionProblemPage />,
  },
  {
    path: '/reset-password',
    element: <ResetPasswordPage />,
  },
  {
    path: '/verify-email',
    element: <VerifyEmailPage />,
  },
  {
    // Public: the undo link goes to the old address, whose owner may have no session.
    path: '/account/email/revert',
    element: <RevertEmailPage />,
  },
  {
    path: '/account/email/confirm',
    element: (
      <AccountRoute>
        <EmailConfirmPage />
      </AccountRoute>
    ),
  },
  {
    path: '*',
    element: <NotFoundPage />,
  },
];

const router = createBrowserRouter(routes.map(withErrorBoundary));

export default router;
