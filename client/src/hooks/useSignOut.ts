// client/src/hooks/useSignOut.ts
import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { del } from '../lib/api';
import { useAuth } from '../context/AuthContext';

// Clears the session cookie, re-resolves auth state (which mints a fresh guest
// session), then sends the user home. Each step is best-effort: a failed DELETE
// or refetch still ends on '/' so the user is never stranded on a signed-in page.
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
