import { createBrowserRouter, type RouteObject } from 'react-router-dom';
import ProtectedRoute from './components/ProtectedRoute';
import GuestRoute from './components/GuestRoute';
import AccountRoute from './components/AccountRoute';
import RouteErrorBoundary from './components/RouteErrorBoundary';
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
import DataMetricsPage from './pages/DataMetricsPage';
import SoilPage from './pages/SoilPage';
import WeatherPage from './pages/WeatherPage';
import AmendmentPage from './pages/AmendmentPage';
import AccountPage from './pages/AccountPage';
import EmailConfirmPage from './pages/EmailConfirmPage';
import NotFoundPage from './pages/NotFoundPage';

const routes: RouteObject[] = [
  {
    path: '/',
    element: (
      <ProtectedRoute requireOnboarding>
        <HomePage />
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
    path: '/data',
    element: (
      <AccountRoute>
        <DataMetricsPage />
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
    path: '/account/email/confirm',
    element: (
      <AccountRoute>
        <EmailConfirmPage />
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
  {
    path: '*',
    element: <NotFoundPage />,
  },
];

const router = createBrowserRouter(routes.map((route) => ({ ...route, errorElement: <RouteErrorBoundary /> })));

export default router;
