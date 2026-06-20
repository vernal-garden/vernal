import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function GuestRoute({ children }: { children: React.ReactNode }) {
  const { state } = useAuth();

  if (state.kind === 'loading') return null;
  if (state.kind === 'account') return <Navigate to="/" replace />;
  return <>{children}</>;
}
