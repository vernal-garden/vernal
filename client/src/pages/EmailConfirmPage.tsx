import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { get, ApiError } from '../lib/api';

type Status = { kind: 'loading' } | { kind: 'success'; email: string } | { kind: 'error'; message: string };

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

export default function EmailConfirmPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');
  const [status, setStatus] = useState<Status>({ kind: 'loading' });

  useEffect(() => {
    if (!token) {
      setStatus({ kind: 'error', message: 'Token is required.' });
      return;
    }
    get<{ email: string }>(`/api/me/email/confirm?token=${encodeURIComponent(token)}`)
      .then((res) => setStatus({ kind: 'success', email: res!.email }))
      .catch((err) => {
        const message =
          err instanceof ApiError && (err.body as { error?: string } | null)?.error
            ? (err.body as { error: string }).error
            : 'Something went wrong confirming your email.';
        setStatus({ kind: 'error', message });
      });
  }, [token]);

  return (
    <div style={wrapperSt}>
      {status.kind === 'loading' && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--sp-8) 0' }}>
          <div
            style={{
              width: 32,
              height: 32,
              border: '2px solid var(--c-primary-light)',
              borderTopColor: 'var(--c-primary)',
              borderRadius: '50%',
              animation: 'spin 0.8s linear infinite',
            }}
          />
        </div>
      )}

      {status.kind === 'success' && (
        <>
          <h1 style={headingSt}>Your email has been updated</h1>
          <p style={bodyTextSt}>Your account email is now {status.email}.</p>
          <Link to="/account" style={linkSt}>
            Back to account
          </Link>
        </>
      )}

      {status.kind === 'error' && (
        <>
          <h1 style={headingSt}>Couldn't confirm email</h1>
          <p style={{ ...bodyTextSt, color: 'var(--c-danger)' }}>{status.message}</p>
          <Link to="/account" style={linkSt}>
            Back to account
          </Link>
        </>
      )}
    </div>
  );
}
