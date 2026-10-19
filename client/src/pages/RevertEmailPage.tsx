import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { post } from '../lib/api';
import { getUrlToken } from '../instrument';
import { apiErrorMessage } from '../components/account/settingsStyles';

type Status =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'done'; email: string }
  | { kind: 'error'; message: string };

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

const buttonSt: React.CSSProperties = {
  marginTop: 'var(--sp-4)',
  padding: '10px 24px',
  fontSize: 14,
  fontFamily: 'var(--font-ui)',
  fontWeight: 600,
  border: 'none',
  borderRadius: 'var(--r-md)',
  background: 'var(--c-primary)',
  color: 'var(--c-text-on-primary)',
  cursor: 'pointer',
};

const linkSt: React.CSSProperties = {
  display: 'inline-block',
  marginTop: 'var(--sp-4)',
  color: 'var(--c-primary)',
  fontFamily: 'var(--font-ui)',
  fontSize: 14,
};

// Public: the link goes to the replaced address, whose owner may have no
// session. Nothing is sent until the button is pressed, because mail
// scanners open links.
export default function RevertEmailPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  // Read once, then drop it from the address bar (history, Sentry, replays).
  const [token] = useState(() => getUrlToken(location.pathname) ?? searchParams.get('token'));
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  useEffect(() => {
    if (searchParams.has('token')) navigate(location.pathname, { replace: true });
  }, [searchParams, navigate, location.pathname]);

  async function handleUndo() {
    if (!token) return;
    setStatus({ kind: 'submitting' });
    try {
      const res = await post<{ data: { email: string } }>('/api/auth/email/revert', { token });
      setStatus({ kind: 'done', email: res!.data.email });
    } catch (err) {
      setStatus({ kind: 'error', message: apiErrorMessage(err, 'Something went wrong. Please try again.') });
    }
  }

  if (!token) {
    return (
      <div style={wrapperSt}>
        <h1 style={headingSt}>Link not valid</h1>
        <p style={bodyTextSt}>This link is invalid or has expired.</p>
      </div>
    );
  }

  if (status.kind === 'done') {
    return (
      <div style={wrapperSt} role="status">
        <h1 style={headingSt}>Change undone</h1>
        <p style={bodyTextSt}>
          Done. Your email is back to {status.email}, and every device has been signed out. We've emailed you a
          link to set a new password.
        </p>
        {/* A full page load, so the app re-reads the (now signed-out) session. */}
        <a href="/login" style={linkSt}>
          Go to sign in
        </a>
      </div>
    );
  }

  return (
    <div style={wrapperSt}>
      <h1 style={headingSt}>Undo the email change on your Vernal account?</h1>
      <p style={bodyTextSt}>
        This puts your previous email address back, signs out every device, and emails you a link to set a new
        password.
      </p>
      <button type="button" onClick={handleUndo} disabled={status.kind === 'submitting'} style={buttonSt}>
        {status.kind === 'submitting' ? 'Undoing…' : 'Undo this change'}
      </button>
      {status.kind === 'error' && (
        <p role="status" style={{ ...bodyTextSt, marginTop: 'var(--sp-3)', color: 'var(--c-danger)' }}>
          {status.message}
        </p>
      )}
    </div>
  );
}
