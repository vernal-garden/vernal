import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function AccountRoute({ children }: { children: React.ReactNode }) {
  const { state } = useAuth();

  if (state.kind === 'loading') return null;
  if (state.kind === 'account') return <>{children}</>;
  if (state.kind === 'guest') return <Navigate to="/login" state={{ intent: 'create-account' }} replace />;
  // expired
  return <Navigate to="/session-expired" replace />;
}
