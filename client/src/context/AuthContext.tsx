import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import * as api from '../lib/api';

// ── Public types ─────────────────────────────────────────────────────────────

export interface SessionAccount {
  id: string;
  email: string | null;
  role: 'user' | 'admin';
  subscriptionTier: 'free' | 'supporter';
  deletionScheduledAt: string | null;
  supporterPromptShown: boolean;
}

export interface PendingGuestData {
  gardenName: string;
  bedCount: number;
  plantCount: number;
}

export type SessionState =
  | { kind: 'loading' }
  | { kind: 'guest'; expiresAt: string; daysRemaining: number; gardenCount: number }
  | { kind: 'account'; account: SessionAccount; pendingGuestData: PendingGuestData | null; gardenCount: number }
  // cookiesBlocked: the server issued a session cookie but the browser never sent
  // it back (cookies blocked for this site), so no sign-in can stick.
  | { kind: 'expired'; recoverable: boolean; cookiesBlocked?: boolean }
  | { kind: 'unreachable'; reason: UnreachableReason };

// network: the request never reached the server. server: it answered 5xx.
// busy: it answered 429 (rate limited — e.g. many new visitors on one network).
export type UnreachableReason = 'network' | 'server' | 'busy';

export interface AuthContextValue {
  state: SessionState;
  isGuest: boolean;
  isAccount: boolean;
  account: SessionAccount | null;
  pendingGuestData: PendingGuestData | null;
  daysRemaining: number | null;
  gardenCount: number | null;
  refetch: () => Promise<void>;
  markSupporterPromptShown: () => Promise<void>;
}

// ── Context ───────────────────────────────────────────────────────────────────

const AuthContext = createContext<AuthContextValue | null>(null);

// ── Provider ──────────────────────────────────────────────────────────────────

// Maps a failed session resolve to the state the user should see. Only a 4xx
// other than 429 means the session itself is bad.
function failureState(err: unknown): SessionState {
  if (err instanceof api.ApiError) {
    if (err.status === 429) return { kind: 'unreachable', reason: 'busy' };
    if (err.status >= 500) return { kind: 'unreachable', reason: 'server' };
    return { kind: 'expired', recoverable: false };
  }
  return { kind: 'unreachable', reason: 'network' };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<SessionState>({ kind: 'loading' });

  // allowBootstrap is per-call (not a once-per-page-load ref) so that refetch()
  // after sign-out can mint a fresh guest session; the recursive call passes
  // false so a bootstrap that still yields no session can't loop.
  const resolveSession = useCallback(async (allowBootstrap = true): Promise<void> => {
    const body = await api.get<{ data: Record<string, unknown> }>('/api/auth/session');
    const data = body!.data;

    // Guest ─ fetch gardens for requireOnboarding guard
    if (data['isGuest'] === true) {
      const gardens = await api.get<{ data: unknown[] }>('/api/gardens');
      setState({
        kind: 'guest',
        expiresAt: data['expiresAt'] as string,
        daysRemaining: data['daysRemaining'] as number,
        gardenCount: gardens?.data.length ?? 0,
      });
      return;
    }

    // Authenticated account ─ fetch gardens for requireOnboarding guard
    if (data['authenticated'] === true) {
      const [gardens, me] = await Promise.all([
        api.get<{ data: unknown[] }>('/api/gardens'),
        api.get<{ data: { supporterPromptShown: boolean } }>('/api/me'),
      ]);
      setState({
        kind: 'account',
        account: {
          ...(data['account'] as SessionAccount),
          id: String((data['account'] as SessionAccount).id),
          supporterPromptShown: me?.data.supporterPromptShown ?? false,
        },
        pendingGuestData: (data['pendingGuestData'] as PendingGuestData | null) ?? null,
        gardenCount: gardens?.data.length ?? 0,
      });
      return;
    }

    // Expired guest session whose data can still be claimed by logging in
    if (data['guestExpired'] === 'recoverable') {
      setState({ kind: 'expired', recoverable: true });
      return;
    }

    // No session, or a cookie whose session row is gone (nothing left to
    // recover) — bootstrap a fresh guest session, then re-resolve
    if (allowBootstrap) {
      await api.post('/api/auth/guest');
      await resolveSession(false);
      return;
    }

    // Bootstrap returned a cookie but the browser didn't send it back
    setState({ kind: 'expired', recoverable: false, cookiesBlocked: true });
  }, []);

  const markSupporterPromptShown = useCallback(async (): Promise<void> => {
    try {
      await api.post('/api/me/supporter-prompt/shown');
      setState(prev =>
        prev.kind === 'account'
          ? { ...prev, account: { ...prev.account, supporterPromptShown: true } }
          : prev,
      );
    } catch {
      // Best-effort — a network blip should not break the placement flow.
    }
  }, []);

  const refetch = useCallback(() => resolveSession(), [resolveSession]);

  useEffect(() => {
    resolveSession().catch((err: unknown) => {
      setState(failureState(err));
    });
  }, [resolveSession]);

  // ── Derived context values ────────────────────────────────────────────────

  let isGuest = false;
  let isAccount = false;
  let account: SessionAccount | null = null;
  let pendingGuestData: PendingGuestData | null = null;
  let daysRemaining: number | null = null;
  let gardenCount: number | null = null;

  if (state.kind === 'guest') {
    isGuest = true;
    daysRemaining = state.daysRemaining;
    gardenCount = state.gardenCount;
  } else if (state.kind === 'account') {
    isAccount = true;
    account = state.account;
    pendingGuestData = state.pendingGuestData;
    gardenCount = state.gardenCount;
  }

  return (
    <AuthContext.Provider
      value={{
        state,
        isGuest,
        isAccount,
        account,
        pendingGuestData,
        daysRemaining,
        gardenCount,
        refetch,
        markSupporterPromptShown,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be called within <AuthProvider>');
  return ctx;
}
