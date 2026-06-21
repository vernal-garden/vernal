import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import * as api from '../lib/api';

// ── Public types ─────────────────────────────────────────────────────────────

export interface SessionAccount {
  id: string;
  email: string | null;
  role: 'user' | 'admin';
  subscriptionTier: 'free' | 'supporter';
  deletionScheduledAt: string | null;
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
  | { kind: 'expired'; recoverable: boolean };

export interface AuthContextValue {
  state: SessionState;
  isGuest: boolean;
  isAccount: boolean;
  account: SessionAccount | null;
  pendingGuestData: PendingGuestData | null;
  daysRemaining: number | null;
  gardenCount: number | null;
  refetch: () => Promise<void>;
}

// ── Context ───────────────────────────────────────────────────────────────────

const AuthContext = createContext<AuthContextValue | null>(null);

// ── Provider ──────────────────────────────────────────────────────────────────

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<SessionState>({ kind: 'loading' });
  const bootstrapped = useRef(false);

  const resolveSession = useCallback(async (): Promise<void> => {
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
      const gardens = await api.get<{ data: unknown[] }>('/api/gardens');
      setState({
        kind: 'account',
        account: { ...(data['account'] as SessionAccount), id: String((data['account'] as SessionAccount).id) },
        pendingGuestData: (data['pendingGuestData'] as PendingGuestData | null) ?? null,
        gardenCount: gardens?.data.length ?? 0,
      });
      return;
    }

    // Expired guest session
    if (data['guestExpired']) {
      setState({
        kind: 'expired',
        recoverable: data['guestExpired'] === 'recoverable',
      });
      return;
    }

    // No session (true first visit) — bootstrap once, then re-resolve
    if (!bootstrapped.current) {
      bootstrapped.current = true;
      await api.post('/api/auth/guest');
      await resolveSession();
      return;
    }

    // Degenerate: bootstrap ran but still no session — show expired UI
    setState({ kind: 'expired', recoverable: false });
  }, []); // bootstrapped ref is stable; no deps needed

  useEffect(() => {
    resolveSession().catch(() => {
      setState({ kind: 'expired', recoverable: false });
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
        refetch: resolveSession,
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
