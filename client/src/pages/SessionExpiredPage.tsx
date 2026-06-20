import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function SessionExpiredPage() {
  const { state } = useAuth();

  if (state.kind === 'loading') return null;
  if (state.kind !== 'expired') return <Navigate to="/" replace />;

  return (
    <div>
      {state.recoverable
        ? 'Your session expired. Your data may still be recoverable — log in to restore it.'
        : 'Your session has expired and your data is no longer available. Create a new account to start fresh.'}
    </div>
  );
}
