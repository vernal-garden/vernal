import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { ApiError, get } from '../../lib/api';
import { apiErrorMessage } from '../../lib/adminApi';
import Button from './Button';
import FieldList from './FieldList';

export interface SeedDetailModalProps {
  /** cambium.seeds id. */
  seedId: number;
  /** Shown as the title while loading / on error. */
  fallbackName: string;
  onClose: () => void;
}

const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface CompanionLike {
  seed?: { commonName?: string } | null;
  relationship?: string;
}

// Turns the companions array into readable text ("Basil (beneficial)").
function companionsText(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((c: CompanionLike) => {
    const name = c?.seed?.commonName ?? 'Unknown';
    return c?.relationship ? `${name} (${c.relationship})` : name;
  });
}

// Read-only view of a Cambium seed (GET /api/catalogue/seeds/:id) as a labelled field list.
export default function SeedDetailModal({ seedId, fallbackName, onClose }: SeedDetailModalProps) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  // Backdrop closes only when both mousedown and click land on it.
  const downOnBackdrop = useRef(false);
  const closeFn = useRef(onClose);
  closeFn.current = onClose;
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    get<Record<string, unknown>>(`/api/catalogue/seeds/${seedId}`)
      .then((d) => {
        if (!cancelled) setDetail(d ?? {});
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(
          err instanceof ApiError && err.status === 404
            ? 'This seed is not in the public catalogue (it may be pending moderation).'
            : apiErrorMessage(err, 'Could not load this seed.'),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [seedId]);

  // Focus on open; return focus to the opener on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    (closeRef.current ?? dialogRef.current)?.focus();
    return () => opener?.focus?.();
  }, []);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeFn.current();
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

  const title = typeof detail?.commonName === 'string' ? detail.commonName : fallbackName;
  const entries: Array<[string, unknown]> = detail
    ? Object.entries(detail).map(([k, v]) => [k, k === 'companions' ? companionsText(v) : v])
    : [];

  return (
    <div
      onMouseDown={(e) => {
        downOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        const both = downOnBackdrop.current && e.target === e.currentTarget;
        downOnBackdrop.current = false;
        if (both) closeFn.current();
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
          outline: 'none',
          width: 640,
          maxWidth: '100%',
          maxHeight: '85vh',
          display: 'flex',
          flexDirection: 'column',
          boxSizing: 'border-box',
          background: 'var(--c-surface)',
          borderRadius: 'var(--r-lg)',
          boxShadow: 'var(--shadow-lg)',
          fontFamily: 'var(--font-ui)',
          fontSize: 14,
          color: 'var(--c-text)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 'var(--sp-3)',
            padding: 'var(--sp-4) var(--sp-5)',
            borderBottom: '1px solid var(--c-border)',
          }}
        >
          <h2 id={titleId} style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
            {title}
          </h2>
          <Button ref={closeRef} variant="secondary" onClick={onClose}>
            Close
          </Button>
        </div>
        <div style={{ padding: 'var(--sp-4) var(--sp-5)', overflowY: 'auto' }}>
          {error ? (
            <p role="alert" style={{ margin: 0, color: 'var(--c-danger)' }}>
              {error}
            </p>
          ) : detail ? (
            <FieldList entries={entries} />
          ) : (
            <p style={{ margin: 0, color: 'var(--c-text-3)' }}>Loading…</p>
          )}
        </div>
      </div>
    </div>
  );
}
