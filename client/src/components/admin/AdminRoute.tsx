import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useIsMobile } from '../../hooks/useIsMobile';
import BetterOnDesktop, { DESKTOP_MESSAGES } from '../shell/BetterOnDesktop';

// Admin-only guard. Anyone who isn't a signed-in admin goes back to the app;
// admins on a phone get the desktop-only notice instead of the dashboard.
export default function AdminRoute({ children }: { children: React.ReactNode }) {
  const { state } = useAuth();
  const isMobile = useIsMobile();

  if (state.kind === 'loading') return null;
  if (state.kind !== 'account' || state.account.role !== 'admin') return <Navigate to="/" replace />;
  if (isMobile) return <BetterOnDesktop variant="fullscreen" message={DESKTOP_MESSAGES.admin} />;
  return <>{children}</>;
}
