import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

// Desktop modal for the harvest log: backdrop click and Escape close, focus is
// trapped inside and restored on close, body scroll is locked. Only the
// topmost open modal responds to Escape.

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const stack: symbol[] = [];

interface Props {
  ariaLabel: string;
  onClose: () => void;
  children: ReactNode;
  maxWidth?: number;
  // Defaults to the first focusable element.
  initialFocus?: RefObject<HTMLElement | null>;
}

export default function HarvestModal({ ariaLabel, onClose, children, maxWidth = 520, initialFocus }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const id = Symbol('modal');
    stack.push(id);
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const first = initialFocus?.current ?? panelRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panelRef.current)?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (stack[stack.length - 1] !== id) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab' || !panelRef.current) return;
      const items = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null,
      );
      if (items.length === 0) return;
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      const inside = panelRef.current.contains(document.activeElement);
      if (e.shiftKey && (document.activeElement === firstItem || !inside)) {
        e.preventDefault();
        lastItem.focus();
      } else if (!e.shiftKey && (document.activeElement === lastItem || !inside)) {
        e.preventDefault();
        firstItem.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      stack.splice(stack.indexOf(id), 1);
      document.body.style.overflow = prevOverflow;
      previouslyFocused?.focus?.();
    };
    // Runs once per mount; initialFocus is read on open only.
  }, []);

  return createPortal(
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) onCloseRef.current();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 200,
        background: 'rgba(42,35,24,0.55)', // --c-text at 55%, as SeedDetailOverlay
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: '40px 16px',
        overflowY: 'auto',
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
        style={{
          width: '100%',
          maxWidth,
          boxSizing: 'border-box',
          background: 'var(--c-surface)',
          borderRadius: 'var(--r-xl)',
          boxShadow: 'var(--shadow-lg)',
          fontFamily: 'var(--font-ui)',
          outline: 'none',
        }}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
