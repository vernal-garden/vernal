import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import Button from './Button';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel: string;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
  busy?: boolean;
  error?: string | null;
  /** Extra content under the message, e.g. a note textarea. Its first field gets focus. */
  children?: ReactNode;
  /** Confirm button style (default 'primary'). */
  variant?: 'primary' | 'danger';
}

const FIELDS = 'input, textarea, select';
const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  onConfirm,
  onCancel,
  busy = false,
  error,
  children,
  variant = 'primary',
}: ConfirmDialogProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const extraRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  // Backdrop closes only when both mousedown and click land on it, so a text
  // selection dragged out of the dialog doesn't dismiss it.
  const downOnBackdrop = useRef(false);

  // Focus on open; return focus to the opener on close.
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const field = extraRef.current?.querySelector<HTMLElement>(FIELDS);
    (field ?? confirmRef.current ?? dialogRef.current)?.focus();
    return () => opener?.focus?.();
  }, [open]);

  if (!open) return null;

  function cancel() {
    if (!busyRef.current) cancelRef.current();
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      cancel();
      return;
    }
    if (e.key !== 'Tab' || !dialogRef.current) return;
    const items = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(TABBABLE));
    if (items.length === 0) {
      e.preventDefault();
      dialogRef.current.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === dialogRef.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      onMouseDown={(e) => {
        downOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        const both = downOnBackdrop.current && e.target === e.currentTarget;
        downOnBackdrop.current = false;
        if (both) cancel();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 300,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'var(--sp-4)',
        background: 'color-mix(in srgb, var(--c-text) 40%, transparent)',
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        style={{
          width: 420,
          maxWidth: '100%',
          boxSizing: 'border-box',
          padding: 'var(--sp-5)',
          background: 'var(--c-surface)',
          borderRadius: 'var(--r-lg)',
          boxShadow: 'var(--shadow-lg)',
          fontFamily: 'var(--font-ui)',
          fontSize: 14,
          color: 'var(--c-text)',
          outline: 'none',
        }}
      >
        <h2 id={titleId} style={{ margin: '0 0 var(--sp-3)', fontSize: 16, fontWeight: 600 }}>
          {title}
        </h2>
        <div style={{ color: 'var(--c-text-2)', lineHeight: 1.5 }}>{message}</div>
        {children != null && (
          <div ref={extraRef} style={{ marginTop: 'var(--sp-3)' }}>
            {children}
          </div>
        )}
        {error && (
          <p role="alert" style={{ margin: 'var(--sp-3) 0 0', fontSize: 13, color: 'var(--c-danger)' }}>
            {error}
          </p>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--sp-2)', marginTop: 'var(--sp-4)' }}>
          <Button variant="secondary" disabled={busy} onClick={cancel}>
            Cancel
          </Button>
          <Button
            ref={confirmRef}
            variant={variant}
            disabled={busy}
            aria-busy={busy || undefined}
            onClick={() => {
              Promise.resolve(onConfirm()).catch(() => {});
            }}
          >
            {busy ? 'Working…' : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
