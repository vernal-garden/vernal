import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { post, ApiError } from '../lib/api';
import { getUrlToken } from '../instrument';

type Status = { kind: 'loading' } | { kind: 'success' } | { kind: 'error'; message: string };

const wrapperSt: React.CSSProperties = {
  maxWidth: 480,
  margin: '0 auto',
  padding: 'var(--sp-6) var(--sp-5)',
  textAlign: 'center',
};

const headingSt: React.CSSProperties = {
  margin: '0 0 var(--sp-3)',
  fontFamily: 'var(--font-display)',
  fontSize: 22,
  color: 'var(--c-text)',
};

const bodyTextSt: React.CSSProperties = {
  margin: 0,
  fontFamily: 'var(--font-ui)',
  fontSize: 14,
  color: 'var(--c-text-2)',
  lineHeight: 1.6,
};

const linkSt: React.CSSProperties = {
  display: 'inline-block',
  marginTop: 'var(--sp-4)',
  color: 'var(--c-primary)',
  fontFamily: 'var(--font-ui)',
  fontSize: 14,
};

export default function VerifyEmailPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [token] = useState(() => getUrlToken(location.pathname) ?? searchParams.get('token'));
  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  // Tokens are single-use; StrictMode's double effect must not submit twice.
  const submitted = useRef(false);

  useEffect(() => {
    if (searchParams.has('token')) navigate(location.pathname, { replace: true });
  }, [searchParams, navigate, location.pathname]);

  useEffect(() => {
    if (submitted.current) return;
    submitted.current = true;
    if (!token) {
      setStatus({ kind: 'error', message: 'This verification link is invalid or has expired.' });
      return;
    }
    post('/api/auth/verify-email', { token })
      .then(() => setStatus({ kind: 'success' }))
      .catch((err) => {
        const message =
          err instanceof ApiError && (err.body as { error?: string } | null)?.error
            ? (err.body as { error: string }).error
            : 'Something went wrong verifying your email.';
        setStatus({ kind: 'error', message });
      });
  }, [token]);

  return (
    <div style={wrapperSt} role="status">
      {status.kind === 'loading' && <p style={bodyTextSt}>Verifying your email…</p>}

      {status.kind === 'success' && (
        <>
          <h1 style={headingSt}>Email verified</h1>
          <p style={bodyTextSt}>Thanks, your email address is confirmed.</p>
          <Link to="/" style={linkSt}>
            Go to Vernal
          </Link>
        </>
      )}

      {status.kind === 'error' && (
        <>
          <h1 style={headingSt}>Couldn't verify email</h1>
          <p style={{ ...bodyTextSt, color: 'var(--c-danger)' }}>{status.message}</p>
          <Link to="/account" style={linkSt}>
            Go to your account to send a new link
          </Link>
        </>
      )}
    </div>
  );
}
