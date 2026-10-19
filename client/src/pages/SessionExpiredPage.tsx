import { useState, type CSSProperties } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import * as api from '../lib/api';

const BUTTON_BASE: CSSProperties = {
  minHeight: 44,
  minWidth: 44,
  boxSizing: 'border-box',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '0 var(--sp-5)',
  borderRadius: 'var(--r-md)',
  fontFamily: 'var(--font-ui)',
  fontSize: 15,
  fontWeight: 600,
  textDecoration: 'none',
  cursor: 'pointer',
};

const PRIMARY_BUTTON: CSSProperties = {
  ...BUTTON_BASE,
  border: 'none',
  background: 'var(--c-primary)',
  color: 'var(--c-text-on-primary)',
};

const SECONDARY_BUTTON: CSSProperties = {
  ...BUTTON_BASE,
  border: '1px solid var(--c-border)',
  background: 'var(--c-surface)',
  color: 'var(--c-text)',
};

const PAGE_STYLE: CSSProperties = {
  minHeight: '100vh',
  boxSizing: 'border-box',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  textAlign: 'center',
  gap: 'var(--sp-4)',
  padding: 'var(--sp-6)',
  background: 'var(--c-bg)',
  color: 'var(--c-text)',
  fontFamily: 'var(--font-ui)',
};

export default function SessionExpiredPage() {
  const { state, refetch } = useAuth();
  const navigate = useNavigate();
  const [starting, setStarting] = useState(false);
  const [startProblem, setStartProblem] = useState<null | 'busy' | 'failed'>(null);

  // While a new guest session is being minted the state flips away from
  // 'expired'; `starting` keeps the redirect below from racing our navigate.
  if (state.kind === 'loading') return null;
  if (state.kind !== 'expired' && !starting) return <Navigate to="/" replace />;

  const recoverable = state.kind === 'expired' && state.recoverable;
  const cookiesBlocked = state.kind === 'expired' && state.cookiesBlocked === true;

  async function retry() {
    setStarting(true);
    setStartProblem(null);
    try {
      await refetch();
      navigate('/', { replace: true });
    } catch (err) {
      setStartProblem(err instanceof api.ApiError && err.status === 429 ? 'busy' : 'failed');
    } finally {
      setStarting(false);
    }
  }

  if (cookiesBlocked) {
    return (
      <main
        data-testid="session-cookies-blocked"
        style={PAGE_STYLE}
      >
        <h1
          style={{
            margin: 0,
            fontFamily: 'var(--font-display)',
            fontSize: 24,
            fontWeight: 600,
            lineHeight: 1.3,
            maxWidth: 480,
            color: 'var(--c-primary-dark)',
          }}
        >
          Your browser isn't saving cookies for Vernal
        </h1>
        <p style={{ margin: 0, maxWidth: 420, fontSize: 16, lineHeight: 1.5, color: 'var(--c-text-2)' }}>
          Vernal needs a cookie to keep you signed in. Allow cookies for {window.location.hostname} in your
          browser's site settings (in Brave, check Shields for this site), then try again.
        </p>
        <button
          type="button"
          data-testid="session-cookies-retry"
          onClick={retry}
          disabled={starting}
          style={{ ...PRIMARY_BUTTON, marginTop: 'var(--sp-2)', opacity: starting ? 0.6 : 1, cursor: starting ? 'default' : 'pointer' }}
        >
          Try again
        </button>
        {startProblem && (
          <p role="status" style={{ margin: 0, fontSize: 14, color: 'var(--c-text-2)' }}>
            {startProblem === 'busy'
              ? 'Lots of new visitors from your network right now. Please try again in a few minutes.'
              : "We couldn't reach Vernal just now. Please try again."}
          </p>
        )}
      </main>
    );
  }

  async function startNewGarden() {
    setStarting(true);
    setStartProblem(null);
    try {
      // Same bootstrap as AuthContext: mint a guest session, then re-resolve.
      // The server replaces the stale cookie because it no longer resolves to a session.
      await api.post('/api/auth/guest');
      await refetch();
      navigate('/onboarding', { replace: true });
    } catch (err) {
      setStartProblem(err instanceof api.ApiError && err.status === 429 ? 'busy' : 'failed');
      setStarting(false);
    }
  }

  return (
    <main
      className="vernal-expired"
      data-testid="session-expired"
      data-recoverable={recoverable ? 'true' : 'false'}
      style={PAGE_STYLE}
    >
      <style>{`
        @keyframes vernal-expired-in { from { opacity: 0; } to { opacity: 1; } }
        .vernal-expired { animation: vernal-expired-in 300ms ease-out; }
        @media (prefers-reduced-motion: reduce) {
          .vernal-expired { animation: none; }
        }
      `}</style>

      <h1
        style={{
          margin: 0,
          fontFamily: 'var(--font-display)',
          fontSize: recoverable ? 22 : 28,
          fontWeight: 600,
          lineHeight: 1.3,
          maxWidth: 480,
          color: 'var(--c-primary-dark)',
        }}
      >
        {recoverable
          ? 'Your session expired. Your data may still be recoverable — log in to restore it.'
          : 'Your guest session has ended.'}
      </h1>

      {!recoverable && (
        <p style={{ margin: 0, maxWidth: 420, fontSize: 16, lineHeight: 1.5, color: 'var(--c-text-2)' }}>
          Guest sessions don't last forever. Start a new garden, or create a free account to keep your gardens.
        </p>
      )}

      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'center',
          gap: 'var(--sp-3)',
          marginTop: 'var(--sp-2)',
        }}
      >
        {recoverable ? (
          <Link to="/login" data-testid="session-expired-login" style={PRIMARY_BUTTON}>
            Log in
          </Link>
        ) : (
          <>
            <button
              type="button"
              data-testid="session-expired-start"
              onClick={startNewGarden}
              disabled={starting}
              style={{ ...PRIMARY_BUTTON, opacity: starting ? 0.6 : 1, cursor: starting ? 'default' : 'pointer' }}
            >
              Start a new garden
            </button>
            <Link
              to="/register"
              data-testid="session-expired-register"
              aria-disabled={starting}
              tabIndex={starting ? -1 : undefined}
              onClick={(e) => {
                if (starting) e.preventDefault();
              }}
              style={{ ...SECONDARY_BUTTON, ...(starting ? { pointerEvents: 'none', opacity: 0.6 } : {}) }}
            >
              Create an account
            </Link>
          </>
        )}
      </div>

      {startProblem && (
        <p
          role="status"
          data-testid="session-expired-start-problem"
          style={{ margin: 0, fontSize: 14, color: 'var(--c-text-2)' }}
        >
          {startProblem === 'busy'
            ? 'Lots of new visitors from your network right now. Please try again in a few minutes.'
            : "We couldn't start a new garden just now. Please try again."}
        </p>
      )}
    </main>
  );
}
