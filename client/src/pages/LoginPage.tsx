import { useState, FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import * as api from '../lib/api';
import { useAuth } from '../context/AuthContext';
import AuthFormLayout from '../components/AuthFormLayout';

export default function LoginPage() {
  const { refetch } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const returnTo =
    (location.state as { from?: { pathname?: string } } | null)?.from?.pathname ?? '/';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Forgot-password panel
  const [showForgot, setShowForgot] = useState(false);
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotLoading, setForgotLoading] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      await api.post('/api/auth/login', { email, password });
      await refetch();
      navigate(returnTo, { replace: true });
    } catch (err) {
      if (err instanceof api.ApiError) {
        if (err.status === 401) {
          setError('Incorrect email or password.');
        } else {
          const body = err.body as { error?: string } | null;
          setError(body?.error ?? 'Something went wrong. Please try again.');
        }
      } else {
        setError('Something went wrong. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleForgot(e: FormEvent) {
    e.preventDefault();
    setForgotLoading(true);
    try {
      await api.post('/api/auth/forgot-password', { email: forgotEmail });
    } catch {
      // neutral — no enumeration; always show confirmation
    } finally {
      setForgotLoading(false);
      setForgotSent(true);
    }
  }

  return (
    <AuthFormLayout title="Welcome back" returnTo={returnTo}>
      <form onSubmit={handleSubmit}>
        <div style={{ marginBottom: '1rem' }}>
          <label htmlFor="email" style={labelStyle}>Email</label>
          <input
            id="email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            style={inputStyle}
          />
        </div>

        <div style={{ marginBottom: '1rem' }}>
          <label htmlFor="password" style={labelStyle}>Password</label>
          <div style={{ position: 'relative' }}>
            <input
              id="password"
              type={showPassword ? 'text' : 'password'}
              required
              autoComplete="current-password"
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
        </div>

        {error && <p style={errorStyle}>{error}</p>}

        <button type="submit" disabled={loading} style={primaryBtn}>
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      {!showForgot && (
        <div style={{ marginTop: '0.875rem', textAlign: 'center' }}>
          <button
            type="button"
            onClick={() => { setShowForgot(true); setForgotEmail(email); }}
            style={linkBtn}
          >
            Forgot password?
          </button>
        </div>
      )}

      {showForgot && (
        <div style={{ marginTop: '1rem', padding: '1rem', background: '#f9fafb', borderRadius: '8px' }}>
          {forgotSent ? (
            <p style={{ margin: 0, fontSize: '0.875rem', color: '#374151' }}>
              If that email is in our system, you'll get a reset link shortly.
            </p>
          ) : (
            <form onSubmit={handleForgot}>
              <label htmlFor="forgot-email" style={labelStyle}>Your email</label>
              <input
                id="forgot-email"
                type="email"
                required
                value={forgotEmail}
                onChange={e => setForgotEmail(e.target.value)}
                style={{ ...inputStyle, marginBottom: '0.75rem' }}
              />
              <button type="submit" disabled={forgotLoading} style={secondaryBtn}>
                {forgotLoading ? 'Sending…' : 'Send reset link'}
              </button>
            </form>
          )}
        </div>
      )}

      <p style={{ marginTop: '1.5rem', textAlign: 'center', fontSize: '0.875rem', color: '#6b7280' }}>
        Don't have an account?{' '}
        <Link to="/register" style={{ color: '#4f7c3f', fontWeight: 500 }}>Create one</Link>
      </p>
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

const secondaryBtn = {
  display: 'block',
  width: '100%',
  padding: '0.5rem 1rem',
  background: '#fff',
  color: '#374151',
  border: '1px solid #d1d5db',
  borderRadius: '6px',
  fontSize: '0.875rem',
  fontWeight: 500,
  cursor: 'pointer',
} as const;

const errorStyle = {
  margin: '0 0 0.75rem',
  fontSize: '0.875rem',
  color: '#dc2626',
} as const;

const linkBtn = {
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  color: '#4f7c3f',
  fontSize: '0.875rem',
  padding: 0,
  textDecoration: 'underline',
} as const;
