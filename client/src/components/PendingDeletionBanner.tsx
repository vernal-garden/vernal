import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { post, apiErrorMessage } from '../lib/api';

const GRACE_DAYS = 30;

interface Props {
  // Reports the banner's rendered height (0 when hidden) so other fixed-bottom
  // chrome can sit above it.
  onHeightChange: (height: number) => void;
}

// Shown while the account is scheduled for deletion. The server rejects
// writes with 409 until the deletion is cancelled.
export default function PendingDeletionBanner({ onHeightChange }: Props) {
  const { account, refetch } = useAuth();
  const ref = useRef<HTMLDivElement>(null);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scheduledAt = account?.deletionScheduledAt ?? null;

  useEffect(() => {
    const el = ref.current;
    if (!el) {
      onHeightChange(0);
      return;
    }
    const observer = new ResizeObserver(() => onHeightChange(el.offsetHeight));
    observer.observe(el);
    return () => {
      observer.disconnect();
      onHeightChange(0);
    };
  }, [scheduledAt, onHeightChange]);

  if (!scheduledAt) return null;

  const deletesOn = new Date(new Date(scheduledAt).getTime() + GRACE_DAYS * 24 * 60 * 60 * 1000)
    .toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

  async function handleCancel() {
    setError(null);
    setCancelling(true);
    try {
      await post('/api/me/cancel-deletion');
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not cancel deletion.'));
      setCancelling(false);
      return;
    }
    try {
      await refetch();
    } catch {
      // The cancel succeeded; the next session refetch will catch up.
    }
    setCancelling(false);
  }

  return (
    <div
      ref={ref}
      role="status"
      data-print-hide
      style={{
        position: 'fixed',
        bottom: 'var(--shell-bottom, 0px)',
        left: 0,
        right: 0,
        // Level with the bottom tab bar, below dialogs, sheets and MergePrompt.
        zIndex: 1000,
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 'var(--sp-3)',
        padding: 'var(--sp-3) var(--sp-4)',
        background: 'var(--c-surface)',
        color: 'var(--c-text)',
        borderTop: '1px solid var(--c-border)',
      }}
    >
      <span>
        Your account will be deleted on {deletesOn}. You can view and export your data, but not change it.
        {error && (
          <span style={{ display: 'block', color: 'var(--c-danger)', marginTop: 'var(--sp-1)' }}>{error}</span>
        )}
      </span>
      <button
        type="button"
        onClick={handleCancel}
        disabled={cancelling}
        style={{
          background: 'var(--c-primary)',
          color: 'var(--c-surface)',
          border: 'none',
          borderRadius: 'var(--r-md)',
          padding: 'var(--sp-2) var(--sp-3)',
          cursor: cancelling ? 'default' : 'pointer',
          opacity: cancelling ? 0.6 : 1,
        }}
      >
        {cancelling ? 'Cancelling…' : 'Cancel deletion'}
      </button>
    </div>
  );
}
