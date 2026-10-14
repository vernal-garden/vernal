import { useEffect, useRef, useState } from 'react';
import * as Sentry from '@sentry/react';
import { RouterProvider } from 'react-router-dom';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { AuthProvider } from './context/AuthContext';
import { CanvasPresenceProvider } from './context/CanvasPresenceContext';
import MergePrompt from './components/MergePrompt';
import FeedbackWidget from './components/FeedbackWidget';
import router from './routes';

interface UpdateBannerProps {
  onReload: () => void;
  // Reports the banner's rendered height so fixed-bottom chrome can sit above it.
  onHeightChange: (height: number) => void;
}

function UpdateBanner({ onReload, onHeightChange }: UpdateBannerProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(() => onHeightChange(el.offsetHeight));
    observer.observe(el);
    return () => {
      observer.disconnect();
      onHeightChange(0);
    };
  }, [onHeightChange]);

  return (
    <div
      ref={ref}
      data-print-hide
      style={{
        position: 'fixed',
        bottom: 'var(--shell-bottom, 0px)',
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
        onClick={onReload}
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
  const { needRefresh: [needRefresh], updateServiceWorker } = useRegisterSW();
  const [bannerHeight, setBannerHeight] = useState(0);

  return (
    <Sentry.ErrorBoundary fallback={<p className="p-4 text-red-500">Something went wrong. Please refresh.</p>}>
      <AuthProvider>
        <CanvasPresenceProvider>
          <RouterProvider router={router} />
          <FeedbackWidget bottomOffset={needRefresh ? bannerHeight : 0} />
        </CanvasPresenceProvider>
        <MergePrompt />
      </AuthProvider>
      {needRefresh && (
        <UpdateBanner onReload={() => updateServiceWorker(true)} onHeightChange={setBannerHeight} />
      )}
    </Sentry.ErrorBoundary>
  );
}
