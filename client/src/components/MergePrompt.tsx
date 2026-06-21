import { useState } from 'react';
import * as api from '../lib/api';
import { useAuth } from '../context/AuthContext';

export default function MergePrompt() {
  const { isAccount, pendingGuestData, refetch } = useAuth();
  const [loading, setLoading] = useState<'merge' | 'discard' | null>(null);
  const [error, setError] = useState('');

  if (!isAccount || !pendingGuestData) return null;

  const { gardenName, bedCount, plantCount } = pendingGuestData;
  const beds = `${bedCount} ${bedCount === 1 ? 'bed' : 'beds'}`;
  const plants = `${plantCount} ${plantCount === 1 ? 'plant' : 'plants'}`;

  async function handle(action: 'merge' | 'discard') {
    setLoading(action);
    setError('');
    try {
      const path =
        action === 'merge'
          ? '/api/auth/guest-data/merge'
          : '/api/auth/guest-data/discard';
      await api.post(path);
      await refetch();
    } catch {
      setError('Something went wrong. Please try again.');
      setLoading(null);
    }
  }

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      background: 'rgba(0,0,0,0.45)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 9999,
      padding: '1rem',
    }}>
      <div style={{
        background: '#fff',
        borderRadius: '12px',
        padding: '2rem',
        maxWidth: '420px',
        width: '100%',
        boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
      }}>
        <h2 style={{ margin: '0 0 0.5rem', fontSize: '1.25rem', fontWeight: 600, color: '#1a1a1a' }}>
          Add your guest garden to your account?
        </h2>
        <p style={{ margin: '0 0 1.5rem', color: '#6b7280', fontSize: '0.9375rem' }}>
          {gardenName} — {beds}, {plants}
        </p>

        {error && (
          <p style={{ margin: '0 0 1rem', fontSize: '0.875rem', color: '#dc2626' }}>{error}</p>
        )}

        <div style={{ display: 'flex', gap: '0.75rem' }}>
          <button
            onClick={() => handle('merge')}
            disabled={loading !== null}
            style={{
              flex: 1,
              padding: '0.625rem 1rem',
              background: '#4f7c3f',
              color: '#fff',
              border: 'none',
              borderRadius: '6px',
              fontSize: '0.9375rem',
              fontWeight: 500,
              cursor: loading !== null ? 'not-allowed' : 'pointer',
              opacity: loading !== null ? 0.7 : 1,
            }}
          >
            {loading === 'merge' ? 'Adding…' : 'Add to my account'}
          </button>
          <button
            onClick={() => handle('discard')}
            disabled={loading !== null}
            style={{
              flex: 1,
              padding: '0.625rem 1rem',
              background: '#fff',
              color: '#374151',
              border: '1px solid #d1d5db',
              borderRadius: '6px',
              fontSize: '0.9375rem',
              fontWeight: 500,
              cursor: loading !== null ? 'not-allowed' : 'pointer',
              opacity: loading !== null ? 0.7 : 1,
            }}
          >
            {loading === 'discard' ? 'Discarding…' : 'Discard'}
          </button>
        </div>
      </div>
    </div>
  );
}
