import { useEffect, useState, FormEvent } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import * as api from '../lib/api';
import AuthFormLayout from '../components/AuthFormLayout';
import { getUrlToken } from '../instrument';
import BetaScreenLayout from '../components/BetaScreenLayout';
import { TakeoverConfirm, TakeoverQuestion } from '../components/TakeoverSteps';
import { TAKEOVER_MISC_COPY, TAKEOVER_REPLACE_COPY } from '../lib/takeoverCopy';

// The server's message when it gave a specific reason (e.g. nearly expired).
function ExpiredMessage({ message }: { message?: string }) {
  return (
    <>
      <p style={{ color: '#374151', fontSize: '0.9375rem', marginBottom: '1rem' }}>
        {message || 'This link has expired or is invalid. Request a new one.'}
      </p>
      <Link to="/login" style={{ color: '#4f7c3f', fontWeight: 500, fontSize: '0.9375rem' }}>
        Back to sign in
      </Link>
    </>
  );
}

type Choice = 'mine' | 'not_mine';
// Unverified accounts ask first whether the person created the account.
type Step = 'checking' | 'question' | 'confirm' | 'form';

const INVALID_RESET = 'Invalid or expired reset token';

export default function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  // Read once, then drop it from the address bar (history, Sentry).
  const [token] = useState(() => getUrlToken(location.pathname) ?? searchParams.get('token'));
  useEffect(() => {
    if (searchParams.has('token')) navigate(location.pathname, { replace: true });
  }, [searchParams, navigate, location.pathname]);

  const [step, setStep] = useState<Step>(token ? 'checking' : 'form');
  const [choice, setChoice] = useState<Choice | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  // Set on success; newAccount is what the server did, not what was asked (an
  // account verified since the question gets a plain reset).
  const [success, setSuccess] = useState<{ newAccount: boolean } | null>(null);
  // null: not expired; '' : the usual message; otherwise the server's own.
  const [expired, setExpired] = useState<string | null>(null);
  const [error, setError] = useState('');
  // The link's address, shown with the question.
  const [email, setEmail] = useState<string | null>(null);

  // Read-only: never consumes the token.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    api
      .post<{ data: { unverifiedAccount: boolean; email?: string } }>('/api/auth/reset-password/inspect', { token })
      .then((res) => {
        if (cancelled) return;
        setEmail(res?.data.email ?? null);
        setStep(res?.data.unverifiedAccount ? 'question' : 'form');
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof api.ApiError && err.status === 400) setExpired('');
        // Otherwise the reset itself asks for a choice when one is needed.
        else setStep('form');
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (!token) {
    return (
      <AuthFormLayout title="Reset password">
        <ExpiredMessage />
      </AuthFormLayout>
    );
  }

  if (success) {
    return (
      // Its own key so the heading takes focus (a screen reader hears the result)
      // even though the password step's layout already had focusHeading set.
      <AuthFormLayout
        key="success"
        title={success.newAccount ? TAKEOVER_MISC_COPY.newAccountDoneHeading : 'Reset password'}
        focusHeading
        signInOptions={!success.newAccount}
      >
        <p style={{ color: '#374151', fontSize: '0.9375rem', marginBottom: '1rem' }}>
          {success.newAccount ? TAKEOVER_MISC_COPY.newAccountDone : 'Password updated — sign in to continue.'}
        </p>
        <Link to="/login" style={{ color: '#4f7c3f', fontWeight: 500, fontSize: '0.9375rem' }}>
          Go to sign in
        </Link>
      </AuthFormLayout>
    );
  }

  if (expired !== null) {
    return (
      <AuthFormLayout title="Reset password">
        <ExpiredMessage message={expired} />
      </AuthFormLayout>
    );
  }

  if (step === 'checking') {
    return (
      <BetaScreenLayout testId="reset-password-checking">
        <p style={{ margin: 0, color: 'var(--c-text-3)' }}>{TAKEOVER_MISC_COPY.checking}</p>
      </BetaScreenLayout>
    );
  }

  if (step === 'question') {
    return (
      <BetaScreenLayout testId="reset-password-question">
        <TakeoverQuestion
          email={email}
          busy={false}
          error={error}
          onYes={() => {
            setChoice('mine');
            setStep('form');
          }}
          onNo={() => setStep('confirm')}
        />
      </BetaScreenLayout>
    );
  }

  if (step === 'confirm') {
    return (
      <BetaScreenLayout testId="reset-password-confirm">
        <TakeoverConfirm
          copy={TAKEOVER_REPLACE_COPY}
          busy={false}
          error={error}
          onRemove={() => {
            setChoice('not_mine');
            setStep('form');
          }}
          onBack={() => setStep('question')}
        />
      </BetaScreenLayout>
    );
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = await api.post<{ data?: { newAccount?: boolean } }>(
        '/api/auth/reset-password',
        choice ? { token, password, choice } : { token, password },
      );
      setSuccess({ newAccount: res?.data?.newAccount === true });
    } catch (err) {
      if (api.apiErrorCode(err) === 'takeover_choice_required') {
        // The account turned out to be unverified: ask now. The fields keep their values.
        setChoice(null);
        setStep('question');
      } else if (err instanceof api.ApiError && err.status === 400) {
        const message = api.apiErrorMessage(err, INVALID_RESET);
        setExpired(message === INVALID_RESET ? '' : message);
      } else if (err instanceof api.ApiError && (err.status < 500 || err.status === 502)) {
        // Not invited (403), changed mid-reset (409), billing unreachable (502).
        setError(api.apiErrorMessage(err, 'Something went wrong. Please try again.'));
      } else {
        setError('Something went wrong. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  }

  const forNewAccount = choice === 'not_mine';

  return (
    // Arriving from the question or its confirmation (choice set): focus the
    // heading so a screen reader hears the password step.
    <AuthFormLayout
      title={forNewAccount ? TAKEOVER_MISC_COPY.newAccountPasswordTitle : 'Reset password'}
      focusHeading={choice !== null}
    >
      <form onSubmit={handleSubmit}>
        <div style={{ marginBottom: '1rem' }}>
          <label htmlFor="new-password" style={labelStyle}>New password</label>
          <div style={{ position: 'relative' }}>
            <input
              id="new-password"
              type={showPassword ? 'text' : 'password'}
              required
              minLength={8}
              autoComplete="new-password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              style={{ ...inputStyle, paddingRight: '3.5rem' }}
            />
            <button
              type="button"
              onClick={() => setShowPassword(v => !v)}
              style={showHideStyle}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? 'Hide' : 'Show'}
            </button>
          </div>
          <p style={{ margin: '0.25rem 0 0', fontSize: '0.75rem', color: '#6b7280' }}>
            Minimum 8 characters
          </p>
        </div>

        <div style={{ marginBottom: '1rem' }}>
          <label htmlFor="confirm-password" style={labelStyle}>Confirm password</label>
          <input
            id="confirm-password"
            type={showPassword ? 'text' : 'password'}
            required
            autoComplete="new-password"
            value={confirm}
            onChange={e => setConfirm(e.target.value)}
            style={inputStyle}
          />
        </div>

        {error && <p style={errorStyle}>{error}</p>}

        <button type="submit" disabled={loading} style={primaryBtn}>
          {forNewAccount ? TAKEOVER_MISC_COPY.newAccountSubmit : loading ? 'Updating…' : 'Update password'}
        </button>
      </form>
    </AuthFormLayout>
  );
}

const labelStyle = {
  display: 'block',
  marginBottom: '0.375rem',
  fontSize: '0.875rem',
  fontWeight: 500,
  color: '#374151',
} as const;

const inputStyle = {
  display: 'block',
  width: '100%',
  padding: '0.5rem 0.75rem',
  border: '1px solid #d1d5db',
  borderRadius: '6px',
  fontSize: '0.9375rem',
  color: '#1a1a1a',
  outline: 'none',
  boxSizing: 'border-box',
} as const;

const showHideStyle = {
  position: 'absolute',
  right: '0.75rem',
  top: '50%',
  transform: 'translateY(-50%)',
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  fontSize: '0.8125rem',
  color: '#6b7280',
  padding: 0,
} as const;

const primaryBtn = {
  display: 'block',
  width: '100%',
  padding: '0.625rem 1rem',
  background: '#4f7c3f',
  color: '#fff',
  border: 'none',
  borderRadius: '6px',
  fontSize: '0.9375rem',
  fontWeight: 500,
  cursor: 'pointer',
} as const;

const errorStyle = {
  margin: '0 0 0.75rem',
  fontSize: '0.875rem',
  color: '#dc2626',
} as const;
