import { useEffect, useState } from 'react';

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

  // Scroll-lock + Escape
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onCancel(); }
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = '';
      window.removeEventListener('keydown', onKey);
    };
  }, [onCancel]);

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
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--sp-4)' }}
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal={true}
        aria-label={title}
        onClick={e => e.stopPropagation()}
        style={{ background: 'var(--c-surface)', borderRadius: 'var(--r-lg)', padding: 'var(--sp-5)', width: 400, maxWidth: '100%', boxSizing: 'border-box', boxShadow: 'var(--shadow-lg)' }}
      >
        <div style={{ fontFamily: 'var(--font-display)', fontSize: 16, fontWeight: 600, color: 'var(--c-text)', marginBottom: 'var(--sp-3)' }}>
          {title}
        </div>
        <p style={{ fontFamily: 'var(--font-ui)', fontSize: 14, color: 'var(--c-text-2)', lineHeight: 1.6, margin: '0 0 var(--sp-4)' }}>
          {body}
        </p>
        {failed && (
          <p role="alert" style={{ fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--c-danger)', margin: '0 0 var(--sp-3)' }}>
            Couldn't delete. Try again.
          </p>
        )}
        <div style={{ display: 'flex', gap: 'var(--sp-2)', justifyContent: 'flex-end' }}>
          <button
            onClick={onCancel}
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
        </div>
      </div>
    </div>
  );
}
