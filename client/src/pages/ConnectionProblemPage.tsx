import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function ConnectionProblemPage() {
  const { state, refetch } = useAuth();

  if (state.kind === 'loading') return null;
  if (state.kind !== 'unreachable') return <Navigate to="/" replace />;

  return (
    <div>
      <h1>We're having trouble connecting</h1>
      <p>Vernal couldn't reach the server. Check your connection and try again.</p>
      <button type="button" onClick={() => refetch()}>
        Try again
      </button>
    </div>
  );
}
