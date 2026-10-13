import { useRef, useState } from 'react';
import BottomSheet from '../shell/BottomSheet';
import HarvestModal from './HarvestModal';
import { textButtonStyle } from './formStyles';

interface Props {
  isMobile: boolean;
  // Rejects when the delete failed; the dialog then stays open with an error.
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}

const QUESTION = "Delete this harvest entry? This can't be undone.";

// Delete confirmation: a modal on desktop, a bottom sheet on mobile.
export default function DeleteHarvestDialog({ isMobile, onConfirm, onCancel }: Props) {
  const [deleting, setDeleting] = useState(false);
  const [failed, setFailed] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);

  async function confirm() {
    setDeleting(true);
    setFailed(false);
    try {
      await onConfirm();
    } catch {
      setFailed(true);
      setDeleting(false);
    }
  }

  const body = (
    <div style={{ padding: isMobile ? 'var(--sp-2) var(--sp-4) var(--sp-4)' : 'var(--sp-5)', fontFamily: 'var(--font-ui)' }}>
      <p style={{ margin: '0 0 var(--sp-4)', fontSize: 15, color: 'var(--c-text)', lineHeight: 1.5 }}>{QUESTION}</p>
      {failed && (
        <p role="alert" style={{ margin: '0 0 var(--sp-3)', fontSize: 13, color: 'var(--c-danger)' }}>
          Couldn&rsquo;t delete. Try again.
        </p>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--sp-2)' }}>
        <button ref={cancelRef} type="button" onClick={onCancel} style={{ ...textButtonStyle, flex: isMobile ? 1 : undefined }}>
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void confirm()}
          disabled={deleting}
          style={{
            ...textButtonStyle,
            flex: isMobile ? 1 : undefined,
            border: 'none',
            background: 'var(--c-danger)',
            color: 'var(--c-text-on-primary)',
            fontWeight: 600,
            opacity: deleting ? 0.6 : 1,
          }}
        >
          {deleting ? 'Deleting…' : 'Delete'}
        </button>
      </div>
    </div>
  );

  if (isMobile) {
    return (
      <BottomSheet open onClose={onCancel} title="Delete harvest" ariaLabel="Delete harvest">
        {body}
      </BottomSheet>
    );
  }
  return (
    <HarvestModal ariaLabel="Delete harvest" onClose={onCancel} maxWidth={420} initialFocus={cancelRef}>
      {body}
    </HarvestModal>
  );
}
