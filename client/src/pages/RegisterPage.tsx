import { useState, FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import * as api from '../lib/api';
import { useAuth } from '../context/AuthContext';
import AuthFormLayout from '../components/AuthFormLayout';

export default function RegisterPage() {
  const { isGuest, refetch } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // 409 state — swap form action to login
  const [alreadyExists, setAlreadyExists] = useState(false);

  const title = isGuest ? 'Save your garden' : 'Create your account';

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    setLoading(true);
    setError('');

    if (alreadyExists) {
      // Swapped action: sign in with the existing account
      try {
        await api.post('/api/auth/login', { email, password });
        await refetch();
        navigate('/', { replace: true });
      } catch (err) {
        if (err instanceof api.ApiError && err.status === 401) {
          setError('Incorrect password for this account.');
        } else {
          setError('Something went wrong. Please try again.');
        }
      } finally {
        setLoading(false);
      }
      return;
    }

    try {
      await api.post('/api/auth/register', { email, password });
      await refetch();
      navigate('/', { replace: true });
    } catch (err) {
      if (err instanceof api.ApiError) {
        if (err.status === 409) {
          setAlreadyExists(true);
          setError('');
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

  return (
    <AuthFormLayout title={title}>
      {alreadyExists && (
        <div style={{
          marginBottom: '1rem',
          padding: '0.875rem',
          background: '#fef3c7',
          borderRadius: '8px',
          fontSize: '0.875rem',
          color: '#92400e',
        }}>
          An account with that email already exists — sign in instead?
        </div>
      )}

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
              minLength={8}
              autoComplete={alreadyExists ? 'current-password' : 'new-password'}
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
          {!alreadyExists && (
            <p style={{ margin: '0.25rem 0 0', fontSize: '0.75rem', color: '#6b7280' }}>
              Minimum 8 characters
            </p>
          )}
        </div>

        {error && <p style={errorStyle}>{error}</p>}

        <button type="submit" disabled={loading} style={primaryBtn}>
          {loading
            ? (alreadyExists ? 'Signing in…' : 'Creating account…')
            : (alreadyExists ? 'Sign in' : 'Create account')}
        </button>
      </form>

      <p style={{ marginTop: '1.5rem', textAlign: 'center', fontSize: '0.875rem', color: '#6b7280' }}>
        Already have an account?{' '}
        <Link to="/login" style={{ color: '#4f7c3f', fontWeight: 500 }}>Sign in</Link>
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

const errorStyle = {
  margin: '0 0 0.75rem',
  fontSize: '0.875rem',
  color: '#dc2626',
} as const;
