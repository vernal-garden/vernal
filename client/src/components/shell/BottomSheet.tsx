import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CloseIcon } from './icons';

interface Props {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  ariaLabel?: string;
}

// --c-text (#2A2318) at 40% alpha.
const BACKDROP_COLOR = 'rgba(42,35,24,0.4)';
const ANIMATION_MS = 200;
const CLOSE_DISTANCE_PX = 80;
const CLOSE_VELOCITY_PX_PER_MS = 0.5;
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(REDUCED_MOTION_QUERY);
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    },
    () => window.matchMedia(REDUCED_MOTION_QUERY).matches,
    () => false,
  );
}

interface DragState {
  pointerId: number;
  startY: number;
  lastY: number;
  lastT: number;
  velocity: number; // px/ms, positive = downward
}

export default function BottomSheet({ open, onClose, title, children, ariaLabel }: Props) {
  const reducedMotion = usePrefersReducedMotion();
  // Stays true through the exit animation after `open` goes false.
  const [rendered, setRendered] = useState(open);
  const [dragY, setDragY] = useState(0);
  const [dragging, setDragging] = useState(false);

  const panelRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  if (open && !rendered) setRendered(true);

  const closing = rendered && !open;

  // Finish the exit animation, then unmount.
  useEffect(() => {
    if (!closing) return;
    if (reducedMotion) {
      setRendered(false);
      return;
    }
    const timer = window.setTimeout(() => setRendered(false), ANIMATION_MS);
    return () => window.clearTimeout(timer);
  }, [closing, reducedMotion]);

  // Reset the drag offset whenever the sheet (re)opens.
  useEffect(() => {
    if (open) setDragY(0);
  }, [open]);

  // Focus management: move focus into the panel on open, restore it on close.
  useLayoutEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => {
      previouslyFocused?.focus?.();
    };
  }, [open]);

  // Escape closes.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  // Lock body scroll while mounted.
  useEffect(() => {
    if (!rendered) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [rendered]);

  if (!rendered) return null;

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (closing || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { pointerId: e.pointerId, startY: e.clientY, lastY: e.clientY, lastT: e.timeStamp, velocity: 0 };
    setDragging(true);
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const dt = e.timeStamp - drag.lastT;
    if (dt > 0) drag.velocity = (e.clientY - drag.lastY) / dt;
    drag.lastY = e.clientY;
    drag.lastT = e.timeStamp;
    setDragY(Math.max(0, e.clientY - drag.startY));
  }

  function endDrag(e: React.PointerEvent<HTMLDivElement>, cancelled: boolean) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    const distance = Math.max(0, e.clientY - drag.startY);
    // A pointer that paused before lifting has no release speed.
    const velocity = e.timeStamp - drag.lastT > 100 ? 0 : drag.velocity;
    if (!cancelled && (distance > CLOSE_DISTANCE_PX || velocity > CLOSE_VELOCITY_PX_PER_MS)) {
      onCloseRef.current();
    } else {
      setDragY(0);
    }
  }

  const transition = reducedMotion || dragging ? 'none' : `transform ${ANIMATION_MS}ms ease-out`;
  const transform = closing ? 'translateY(100%)' : `translateY(${dragY}px)`;
  const label = ariaLabel ?? title;

  return createPortal(
    <>
      <style>{`
        @keyframes vernal-sheet-in { from { transform: translateY(100%); } to { transform: translateY(0); } }
        @keyframes vernal-sheet-fade { from { opacity: 0; } to { opacity: 1; } }
      `}</style>
      <div
        aria-hidden="true"
        onClick={() => onCloseRef.current()}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 1100,
          background: BACKDROP_COLOR,
          opacity: closing ? 0 : 1,
          transition: reducedMotion ? 'none' : `opacity ${ANIMATION_MS}ms ease-out`,
          animation: reducedMotion ? 'none' : `vernal-sheet-fade ${ANIMATION_MS}ms ease-out`,
        }}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        style={{
          position: 'fixed',
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 1101,
          maxHeight: '90dvh',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--c-surface)',
          borderTopLeftRadius: 'var(--r-xl)',
          borderTopRightRadius: 'var(--r-xl)',
          boxShadow: 'var(--shadow-lg)',
          paddingBottom: 'env(safe-area-inset-bottom)',
          outline: 'none',
          transform,
          transition,
          animation: reducedMotion ? 'none' : `vernal-sheet-in ${ANIMATION_MS}ms ease-out`,
        }}
      >
        <div
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={(e) => endDrag(e, false)}
          onPointerCancel={(e) => endDrag(e, true)}
          style={{
            height: 44,
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: dragging ? 'grabbing' : 'grab',
            touchAction: 'none',
          }}
        >
          <div style={{ width: 36, height: 4, borderRadius: 'var(--r-full)', background: 'var(--c-border)' }} />
        </div>

        <div
          style={{
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--sp-2)',
            padding: '0 var(--sp-2) 0 var(--sp-4)',
          }}
        >
          <div
            style={{
              flex: 1,
              minWidth: 0,
              fontFamily: 'var(--font-display)',
              fontSize: 18,
              fontWeight: 600,
              color: 'var(--c-text)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {title}
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={() => onCloseRef.current()}
            style={{
              width: 44,
              height: 44,
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 0,
              border: 'none',
              borderRadius: 'var(--r-full)',
              background: 'transparent',
              color: 'var(--c-text-2)',
              cursor: 'pointer',
            }}
          >
            <CloseIcon />
          </button>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
          {children}
        </div>
      </div>
    </>,
    document.body,
  );
}
