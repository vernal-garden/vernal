import * as Sentry from '@sentry/react';
import { RouterProvider } from 'react-router-dom';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { AuthProvider } from './context/AuthContext';
import MergePrompt from './components/MergePrompt';
import router from './routes';

function UpdateBanner() {
  const { needRefresh: [needRefresh], updateServiceWorker } = useRegisterSW();

  if (!needRefresh) return null;

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 'var(--sp-3, 0.75rem)',
        padding: 'var(--sp-3, 0.75rem) var(--sp-4, 1rem)',
        background: 'var(--c-surface)',
        color: 'var(--c-text)',
        borderTop: '1px solid var(--c-border)',
      }}
    >
      <span>Update available</span>
      <button
        onClick={() => updateServiceWorker(true)}
        style={{
          background: 'var(--c-primary)',
          color: 'var(--c-surface)',
          border: 'none',
          borderRadius: 'var(--r-md, 6px)',
          padding: 'var(--sp-2, 0.5rem) var(--sp-3, 0.75rem)',
          cursor: 'pointer',
        }}
      >
        Reload
      </button>
    </div>
  );
}

export default function App() {
  return (
    <Sentry.ErrorBoundary fallback={<p className="p-4 text-red-500">Something went wrong. Please refresh.</p>}>
      <AuthProvider>
        <RouterProvider router={router} />
        <MergePrompt />
      </AuthProvider>
      <UpdateBanner />
    </Sentry.ErrorBoundary>
  );
}
