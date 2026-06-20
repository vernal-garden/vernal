import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

interface Props {
  children: React.ReactNode;
  requireOnboarding?: boolean;
}

export default function ProtectedRoute({ children, requireOnboarding = false }: Props) {
  const { state, gardenCount } = useAuth();

  if (state.kind === 'loading') return null;
  if (state.kind === 'expired') return <Navigate to="/session-expired" replace />;
  // gardenCount is null only for loading/expired, both already handled above
  if (requireOnboarding && gardenCount === 0) return <Navigate to="/onboarding" replace />;
  return <>{children}</>;
}
