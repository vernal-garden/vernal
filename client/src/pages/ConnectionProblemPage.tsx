import { Navigate } from 'react-router-dom';
import { useAuth, type UnreachableReason } from '../context/AuthContext';

const MESSAGES: Record<UnreachableReason, { title: string; body: string }> = {
  network: {
    title: "We're having trouble connecting",
    body: "Vernal couldn't reach the server. Check your connection and try again.",
  },
  server: {
    title: 'Vernal is having trouble right now',
    body: 'Please try again in a moment.',
  },
  busy: {
    title: 'Lots of new visitors right now',
    body: 'Vernal is getting a lot of new visitors from your network. Please try again in a few minutes.',
  },
};

export default function ConnectionProblemPage() {
  const { state, refetch } = useAuth();

  if (state.kind === 'loading') return null;
  if (state.kind !== 'unreachable') return <Navigate to="/" replace />;

  const message = MESSAGES[state.reason];

  return (
    <div>
      <h1>{message.title}</h1>
      <p>{message.body}</p>
      {/* A retry that fails again just leaves this page up. */}
      <button type="button" onClick={() => void refetch().catch(() => {})}>
        Try again
      </button>
    </div>
  );
}
