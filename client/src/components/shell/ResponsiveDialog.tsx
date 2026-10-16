import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useIsMobile } from '../../hooks/useIsMobile';
import BottomSheet from './BottomSheet';
import { CloseIcon } from './icons';

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  // Action buttons, rendered beneath the content.
  footer?: ReactNode;
  // Overrides the accessible name when it must differ from the visible title.
  ariaLabel?: string;
  // Decorative block shown above the title (e.g. an icon).
  hero?: ReactNode;
  // 'center' centres the title and hero text (desktop and mobile body).
  align?: 'start' | 'center';
  // 'row' right-aligns the footer buttons on desktop, 'start' left-aligns them,
  // 'stack' lays them out as a full-width column. Mobile always stacks.
  footerLayout?: 'row' | 'start' | 'stack';
  // Desktop only: show a corner close button (mobile sheets always have one).
  showClose?: boolean;
}

const BACKDROP_COLOR = 'color-mix(in srgb, var(--c-text) 55%, transparent)';
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Scoped rules: inline styles can't express "every button in the footer".
const CSS = `
  .vernal-rd-footer { display: flex; gap: var(--sp-2); }
  .vernal-rd-footer--row { justify-content: flex-end; flex-wrap: wrap; }
  .vernal-rd-footer--start { justify-content: flex-start; flex-wrap: wrap; gap: var(--sp-3); }
  .vernal-rd-footer--stack { flex-direction: column; }
  .vernal-rd-footer--mobile { flex-direction: column; flex-wrap: nowrap; justify-content: flex-start; }
  .vernal-rd-footer--mobile > * { width: 100%; min-height: 44px; box-sizing: border-box; }
  .vernal-rd-body--mobile input:not([type="checkbox"]):not([type="radio"]),
  .vernal-rd-body--mobile select { min-height: 44px; }
`;

function DesktopDialog({
  open, onClose, title, children, footer, ariaLabel, hero, align = 'start', footerLayout = 'row', showClose,
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // A drag that starts inside the panel and ends on the backdrop must not close.
  const downOnBackdropRef = useRef(false);

  // Capture the trigger during render on the closed -> open transition, before
  // React applies any child's autoFocus.
  const triggerRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  if (open && !wasOpenRef.current) triggerRef.current = document.activeElement as HTMLElement | null;
  wasOpenRef.current = open;

  // Focus management: move focus in on open (unless an autoFocus field already
  // has it), restore it on close if the trigger is still in the document.
  useLayoutEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (panel && !panel.contains(document.activeElement)) panel.focus();
    return () => {
      const trigger = triggerRef.current;
      if (trigger?.isConnected) trigger.focus?.();
    };
  }, [open]);

  // Escape closes; Tab / Shift+Tab cycle within the dialog.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panel || !panel.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  // Lock body scroll while open.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  if (!open) return null;

  const centered = align === 'center';

  return createPortal(
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1100,
        background: BACKDROP_COLOR,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '0 var(--sp-4)',
      }}
      onPointerDown={(e) => { downOnBackdropRef.current = e.target === e.currentTarget; }}
      onClick={(e) => {
        if (e.target === e.currentTarget && downOnBackdropRef.current) onCloseRef.current();
        downOnBackdropRef.current = false;
      }}
    >
      <style>{CSS}</style>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={ariaLabel ? undefined : titleId}
        aria-label={ariaLabel}
        tabIndex={-1}
        style={{
          position: 'relative',
          background: 'var(--c-surface)', borderRadius: 'var(--r-xl)',
          boxShadow: 'var(--shadow-lg)', width: '100%', maxWidth: 480,
          maxHeight: '90vh', overflowY: 'auto', boxSizing: 'border-box',
          padding: 'var(--sp-6)', fontFamily: 'var(--font-ui)',
          textAlign: centered ? 'center' : undefined,
          outline: 'none',
        }}
      >
        {showClose && (
          <button
            type="button"
            onClick={() => onCloseRef.current()}
            aria-label="Close"
            style={{
              position: 'absolute', top: 'var(--sp-3)', right: 'var(--sp-3)',
              width: 28, height: 28, padding: 0, borderRadius: 'var(--r-full)',
              border: 'none', background: 'transparent', color: 'var(--c-text-3)',
              cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <CloseIcon />
          </button>
        )}
        {hero}
        <h2
          id={titleId}
          style={{
            margin: '0 0 var(--sp-3)',
            fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 600,
            color: 'var(--c-text)',
          }}
        >
          {title}
        </h2>
        {children}
        {footer && (
          <div
            className={`vernal-rd-footer vernal-rd-footer--${footerLayout}`}
            style={{ marginTop: 'var(--sp-4)' }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

function MobileDialog({ open, onClose, title, children, footer, ariaLabel, hero, align = 'start' }: Props) {
  return (
    <BottomSheet open={open} onClose={onClose} title={title} ariaLabel={ariaLabel}>
      <style>{CSS}</style>
      <div
        className="vernal-rd-body--mobile"
        style={{
          padding: footer ? '0 var(--sp-4)' : '0 var(--sp-4) var(--sp-4)',
          fontFamily: 'var(--font-ui)',
          textAlign: align === 'center' ? 'center' : undefined,
        }}
      >
        {hero}
        {children}
        {footer && (
          <div
            className="vernal-rd-footer vernal-rd-footer--mobile"
            style={{
              marginTop: 'var(--sp-4)', padding: 'var(--sp-3) 0 var(--sp-4)',
              position: 'sticky', bottom: 0, background: 'var(--c-surface)',
            }}
          >
            {footer}
          </div>
        )}
      </div>
    </BottomSheet>
  );
}

// Centered modal on desktop, bottom sheet below 768px.
export default function ResponsiveDialog(props: Props) {
  const isMobile = useIsMobile();
  return isMobile ? <MobileDialog {...props} /> : <DesktopDialog {...props} />;
}
