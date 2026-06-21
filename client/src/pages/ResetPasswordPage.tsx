import { useState, FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import * as api from '../lib/api';
import AuthFormLayout from '../components/AuthFormLayout';

function ExpiredMessage() {
  return (
    <>
      <p style={{ color: '#374151', fontSize: '0.9375rem', marginBottom: '1rem' }}>
        This link has expired or is invalid. Request a new one.
      </p>
      <Link to="/login" style={{ color: '#4f7c3f', fontWeight: 500, fontSize: '0.9375rem' }}>
        Back to sign in
      </Link>
    </>
  );
}

export default function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [expired, setExpired] = useState(false);
  const [error, setError] = useState('');

  if (!token) {
    return (
      <AuthFormLayout title="Reset password">
        <ExpiredMessage />
      </AuthFormLayout>
    );
  }

  if (success) {
    return (
      <AuthFormLayout title="Reset password">
        <p style={{ color: '#374151', fontSize: '0.9375rem', marginBottom: '1rem' }}>
          Password updated — sign in to continue.
        </p>
        <Link to="/login" style={{ color: '#4f7c3f', fontWeight: 500, fontSize: '0.9375rem' }}>
          Go to sign in
        </Link>
      </AuthFormLayout>
    );
  }

  if (expired) {
    return (
      <AuthFormLayout title="Reset password">
        <ExpiredMessage />
      </AuthFormLayout>
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
      await api.post('/api/auth/reset-password', { token, password });
      setSuccess(true);
    } catch (err) {
      if (err instanceof api.ApiError && err.status === 400) {
        setExpired(true);
      } else {
        setError('Something went wrong. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthFormLayout title="Reset password">
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
          {loading ? 'Updating…' : 'Update password'}
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
