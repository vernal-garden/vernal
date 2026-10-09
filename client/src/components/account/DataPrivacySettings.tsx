import { useState } from 'react';
import { post, del } from '../../lib/api';
import { useSignOut } from '../../hooks/useSignOut';
import type { AccountData } from './types';
import {
  cardSt,
  cardTitleSt,
  bodyTextSt,
  inputSt,
  secondaryButtonSt,
  dangerButtonSt,
  errorTextSt,
  apiErrorMessage,
} from './settingsStyles';

interface Props {
  account: AccountData;
  onUpdate: (patch: Partial<AccountData>) => void;
}

function DeleteAccountDialog({ onClose, onDeleted }: { onClose: () => void; onDeleted: () => void }) {
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    setError(null);
    setDeleting(true);
    try {
      await del('/api/me');
      onDeleted();
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not delete your account.'));
      setDeleting(false);
    }
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 400,
        background: 'rgba(42,35,24,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '0 16px',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          background: 'var(--c-surface)',
          borderRadius: 'var(--r-xl)',
          boxShadow: 'var(--shadow-lg)',
          width: '100%',
          maxWidth: 440,
          padding: 'var(--sp-6)',
          fontFamily: 'var(--font-ui)',
        }}
        role="dialog"
        aria-modal="true"
        aria-label="Confirm account deletion"
      >
        <h2 style={{ margin: '0 0 var(--sp-3)', fontFamily: 'var(--font-display)', fontSize: 20, color: 'var(--c-text)' }}>
          Delete your account?
        </h2>
        <p style={bodyTextSt}>
          This schedules deletion of your account and all its data in 30 days. Type <strong>delete</strong> to
          confirm.
        </p>
        <input
          type="text"
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          style={{ ...inputSt, marginTop: 'var(--sp-3)' }}
          autoFocus
        />

        {error && <p style={errorTextSt}>{error}</p>}

        <div style={{ display: 'flex', gap: 'var(--sp-3)', marginTop: 'var(--sp-5)' }}>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={confirmText !== 'delete' || deleting}
            style={{ ...dangerButtonSt, opacity: confirmText !== 'delete' || deleting ? 0.5 : 1 }}
          >
            {deleting ? 'Deleting…' : 'Delete account'}
          </button>
          <button type="button" onClick={onClose} disabled={deleting} style={secondaryButtonSt}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

export default function DataPrivacySettings({ account, onUpdate }: Props) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signOut = useSignOut();

  async function handleCancelDeletion() {
    setError(null);
    setCancelling(true);
    try {
      await post('/api/me/cancel-deletion');
      onUpdate({ deletionScheduledAt: null });
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not cancel deletion.'));
    } finally {
      setCancelling(false);
    }
  }

  return (
    <section>
      <h2 style={{ margin: '0 0 var(--sp-4)', fontFamily: 'var(--font-display)', fontSize: 20, color: 'var(--c-text)' }}>
        Data & Privacy
      </h2>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)' }}>
        <div style={cardSt}>
          <h3 style={cardTitleSt}>Export your data</h3>
          <p style={bodyTextSt}>
            Export is coming in a future update. You'll be able to download all your garden data as a file.
          </p>
          <div style={{ marginTop: 'var(--sp-3)' }}>
            <button type="button" disabled style={{ ...secondaryButtonSt, opacity: 0.5, cursor: 'not-allowed' }}>
              Export your data
            </button>
          </div>
        </div>

        <div style={cardSt}>
          <h3 style={cardTitleSt}>Delete account</h3>

          {account.deletionScheduledAt ? (
            <>
              <p style={bodyTextSt}>
                Your account is scheduled for deletion. This will happen 30 days after you initiated the request.
              </p>
              <div style={{ marginTop: 'var(--sp-3)' }}>
                <button type="button" onClick={handleCancelDeletion} disabled={cancelling} style={secondaryButtonSt}>
                  {cancelling ? 'Cancelling…' : 'Cancel deletion'}
                </button>
              </div>
            </>
          ) : (
            <>
              <p style={bodyTextSt}>Permanently delete your account and all of its data.</p>
              <div style={{ marginTop: 'var(--sp-3)' }}>
                <button type="button" onClick={() => setDialogOpen(true)} style={dangerButtonSt}>
                  Delete account
                </button>
              </div>
            </>
          )}

          {error && <p style={errorTextSt}>{error}</p>}
        </div>
      </div>

      {dialogOpen && (
        <DeleteAccountDialog onClose={() => setDialogOpen(false)} onDeleted={signOut} />
      )}
    </section>
  );
}
