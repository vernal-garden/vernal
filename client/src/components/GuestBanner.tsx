import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useIsMobile } from '../hooks/useIsMobile';
import * as api from '../lib/api';
import { PLANTING_PLACED_EVENT } from '../lib/guestBannerEvents';

const REDUCED_KEY = 'vernal.guestBanner.reduced';

interface Props {
  // true → position:fixed at `top` (mobile, and the nav-less canvas on desktop);
  // false → normal flow, directly below whatever precedes it (desktop AppNav).
  fixed: boolean;
  top: string;
  // Rendered height in px (0 while hidden). AppShell folds it into --shell-top
  // when the banner is fixed.
  onHeightChange: (px: number) => void;
}

type BannerKind = 'final' | 'warning' | 'save';

function readReduced(): boolean {
  try {
    return sessionStorage.getItem(REDUCED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeReduced(value: boolean): void {
  try {
    if (value) sessionStorage.setItem(REDUCED_KEY, '1');
    else sessionStorage.removeItem(REDUCED_KEY);
  } catch {
    // Storage unavailable (private mode) — the choice just won't outlive this render tree.
  }
}

function SaveIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
      <polyline points="17 21 17 13 7 13 7 21" />
      <polyline points="7 3 7 8 15 8" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="18" y1="6" x2="6" y2="18" />
    </svg>
  );
}

const BUTTON_BASE: CSSProperties = {
  minHeight: 44,
  minWidth: 44,
  boxSizing: 'border-box',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '0 var(--sp-4)',
  borderRadius: 'var(--r-md)',
  fontFamily: 'var(--font-ui)',
  fontSize: 14,
  fontWeight: 600,
  whiteSpace: 'nowrap',
  textDecoration: 'none',
  cursor: 'pointer',
};

const PRIMARY_BUTTON: CSSProperties = {
  ...BUTTON_BASE,
  border: 'none',
  background: 'var(--c-primary)',
  color: 'var(--c-text-on-primary)',
};

const SECONDARY_BUTTON: CSSProperties = {
  ...BUTTON_BASE,
  border: 'none',
  background: 'transparent',
  color: 'var(--c-text-2)',
};

export default function GuestBanner({ fixed, top, onHeightChange }: Props) {
  const { state, isGuest, daysRemaining } = useAuth();
  const isMobile = useIsMobile();
  const { pathname } = useLocation();

  const [hasPlanting, setHasPlanting] = useState(false);
  const [reduced, setReduced] = useState(readReduced);
  const [dismissedPath, setDismissedPath] = useState<string | null>(null);
  const [el, setEl] = useState<HTMLElement | null>(null);

  // Latest-request-wins: an older, slower response must not overwrite a newer one.
  const requestId = useRef(0);

  const loadPlantingState = useCallback(async () => {
    const id = ++requestId.current;
    try {
      const res = await api.get<{ data: { activePlantingCount: number }[] }>('/api/gardens');
      if (id !== requestId.current) return;
      setHasPlanting((res?.data ?? []).some((g) => g.activePlantingCount > 0));
    } catch {
      // Best-effort — without the count we simply don't offer the save prompt.
    }
  }, []);

  // Only guests ever see this banner, so only guests pay for the gardens fetch.
  useEffect(() => {
    if (!isGuest) return;
    void loadPlantingState();
    window.addEventListener(PLANTING_PLACED_EVENT, loadPlantingState);
    return () => {
      window.removeEventListener(PLANTING_PLACED_EVENT, loadPlantingState);
      // Invalidate anything still in flight (unmount, or no longer a guest).
      requestId.current++;
    };
  }, [isGuest, loadPlantingState]);

  // The X lasts until the next route change.
  useEffect(() => {
    setDismissedPath((prev) => (prev !== null && prev !== pathname ? null : prev));
  }, [pathname]);

  let kind: BannerKind | null = null;
  if (state.kind === 'guest' && daysRemaining !== null) {
    if (daysRemaining <= 1) kind = 'final';
    else if (daysRemaining <= 7) kind = 'warning';
    else if (hasPlanting) kind = 'save';
  }
  if (kind === 'final' && dismissedPath === pathname) kind = null;
  const isChip = kind !== null && kind !== 'final' && reduced;

  // Report the rendered height; 0 whenever nothing is rendered. The observer
  // entry's border box ignores the slide-in transform, unlike getBoundingClientRect.
  useLayoutEffect(() => {
    if (!el) {
      onHeightChange(0);
      return;
    }
    onHeightChange(el.offsetHeight);
    const ro = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      onHeightChange(entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [el, onHeightChange]);

  if (kind === null) return null;

  function reduce() {
    writeReduced(true);
    setReduced(true);
  }

  function restore() {
    writeReduced(false);
    setReduced(false);
  }

  const wrapperStyle: CSSProperties = {
    // In flow (desktop, under AppNav) it stays static with no z-index so it can
    // never paint over the nav.
    ...(fixed ? { position: 'fixed', top, left: 0, right: 0, zIndex: 1000 } : {}),
    boxSizing: 'border-box',
    fontFamily: 'var(--font-ui)',
    color: 'var(--c-text)',
  };

  const styleTag = (
    <style>{`
      @keyframes vernal-gb-in { from { transform: translateY(-100%); } to { transform: none; } }
      @keyframes vernal-gb-collapse { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: none; } }
      @keyframes vernal-gb-reveal { from { clip-path: inset(0 0 100% 0); } to { clip-path: inset(0); } }
      .vernal-gb-banner { animation: vernal-gb-in 250ms ease-out; }
      .vernal-gb-banner[data-flow] { animation-name: vernal-gb-reveal; }
      .vernal-gb-chip { animation: vernal-gb-collapse 200ms ease-out; }
      @media (prefers-reduced-motion: reduce) {
        .vernal-gb-banner, .vernal-gb-chip { animation: none; }
      }
    `}</style>
  );

  if (isChip) {
    return (
      <section
        ref={setEl}
        aria-label="Save your garden"
        data-testid="guest-banner"
        data-state="reduced"
        className="vernal-gb-chip"
        style={{
          ...wrapperStyle,
          // Fits the chip and sits at the end, so nothing else is covered.
          ...(fixed ? { left: 'auto' } : { width: 'fit-content', marginLeft: 'auto' }),
          padding: '0 var(--sp-2)',
        }}
      >
        {styleTag}
        <button
          type="button"
          data-testid="guest-banner-chip"
          onClick={restore}
          style={{
            ...SECONDARY_BUTTON,
            gap: 'var(--sp-2)',
            fontSize: 13,
            color: 'var(--c-primary-dark)',
            background: 'var(--c-primary-subtle)',
            border: '1px solid var(--c-border-subtle)',
            borderRadius: 'var(--r-full)',
          }}
        >
          <SaveIcon />
          Save your garden
        </button>
      </section>
    );
  }

  const isFinal = kind === 'final';
  const message =
    kind === 'final'
      ? 'Your garden is being deleted tomorrow — create a free account to keep it.'
      : kind === 'warning'
        ? `Your garden will be deleted in ${daysRemaining} days — save it by creating a free account.`
        : 'Your garden is ready to save — create a free account to keep it and access it on any device.';

  return (
    <section
      ref={setEl}
      aria-label={isFinal ? 'Garden deletion warning' : kind === 'warning' ? 'Garden expiry warning' : 'Save your garden'}
      data-testid="guest-banner"
      data-state={kind}
      className="vernal-gb-banner"
      data-flow={fixed ? undefined : ''}
      style={{
        ...wrapperStyle,
        display: 'flex',
        flexDirection: isMobile ? 'column' : 'row',
        alignItems: isMobile ? 'stretch' : 'center',
        gap: isMobile ? 'var(--sp-1)' : 'var(--sp-4)',
        padding: isMobile ? 'var(--sp-2) var(--sp-3)' : 'var(--sp-2) var(--sp-6)',
        minHeight: isMobile ? undefined : 52,
        background: kind === 'save' ? 'var(--c-primary-subtle)' : 'var(--c-warning-bg)',
        borderBottom: '1px solid var(--c-border-subtle)',
      }}
    >
      {styleTag}
      <p
        style={{
          flex: 1,
          minWidth: 0,
          margin: 0,
          fontSize: isMobile ? 13 : 14,
          lineHeight: 1.4,
        }}
      >
        {message}
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-1)', flexShrink: 0 }}>
        <Link to="/register" data-testid="guest-banner-create" style={PRIMARY_BUTTON}>
          Create account
        </Link>
        {!isFinal && (
          <button type="button" data-testid="guest-banner-later" onClick={reduce} style={SECONDARY_BUTTON}>
            {kind === 'warning' ? 'Remind me later' : 'Maybe later'}
          </button>
        )}
        {isFinal && (
          <button
            type="button"
            aria-label="Dismiss"
            data-testid="guest-banner-dismiss"
            onClick={() => setDismissedPath(pathname)}
            style={{ ...SECONDARY_BUTTON, padding: 0, width: 44 }}
          >
            <CloseIcon />
          </button>
        )}
      </div>
    </section>
  );
}
