// client/src/hooks/useSignOut.ts
import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { del } from '../lib/api';
import { useAuth } from '../context/AuthContext';

// Clears the session cookie, re-resolves auth state (a fresh guest session, or
// private_beta while guest mode is off), then sends the user to '/'. Each step
// is best-effort, and failures are silent: after a failed DELETE the session
// still stands, and the guards on '/' decide where the user ends up.
export function useSignOut(): () => Promise<void> {
  const { refetch } = useAuth();
  const navigate = useNavigate();

  return useCallback(async () => {
    try {
      await del('/api/auth/session');
    } catch {
      // Fall through — refetch reflects whatever the server now thinks.
    }
    try {
      await refetch();
    } catch {
      // Fall through — navigation still happens.
    }
    navigate('/', { replace: true });
  }, [refetch, navigate]);
}
