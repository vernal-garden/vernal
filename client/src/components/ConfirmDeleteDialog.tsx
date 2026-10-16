import { useState } from 'react';
import ResponsiveDialog from './shell/ResponsiveDialog';

interface Props {
  title: string;
  body: string;
  confirmLabel: string;
  // Rejects when the delete failed; the dialog then stays open with an error.
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}

// Delete confirmation modal, modeled on GardenCard's delete dialog.
export default function ConfirmDeleteDialog({ title, body, confirmLabel, onConfirm, onCancel }: Props) {
  const [deleting, setDeleting] = useState(false);
  const [failed, setFailed] = useState(false);

  async function handleConfirm() {
    setDeleting(true);
    setFailed(false);
    try {
      await onConfirm();
    } catch {
      setFailed(true);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <ResponsiveDialog
      open
      onClose={deleting ? () => {} : onCancel}
      title={title}
      footer={
        <>
          <button
            onClick={onCancel}
            disabled={deleting}
            style={{ padding: 'var(--sp-2) var(--sp-4)', borderRadius: 'var(--r-md)', border: '1px solid var(--c-border)', background: 'transparent', color: 'var(--c-text)', fontFamily: 'var(--font-ui)', fontSize: 13, cursor: 'pointer' }}
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={deleting}
            style={{ padding: 'var(--sp-2) var(--sp-4)', borderRadius: 'var(--r-md)', border: 'none', background: 'var(--c-danger)', color: 'var(--c-text-on-primary)', fontFamily: 'var(--font-ui)', fontSize: 13, cursor: 'pointer', opacity: deleting ? 0.6 : 1 }}
          >
            {deleting ? 'Deleting…' : confirmLabel}
          </button>
        </>
      }
    >
      <p style={{ fontFamily: 'var(--font-ui)', fontSize: 14, color: 'var(--c-text-2)', lineHeight: 1.6, margin: 0 }}>
        {body}
      </p>
      {failed && (
        <p role="alert" style={{ fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--c-danger)', margin: 'var(--sp-3) 0 0' }}>
          Couldn't delete. Try again.
        </p>
      )}
    </ResponsiveDialog>
  );
}
