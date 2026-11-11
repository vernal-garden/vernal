import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { useAuth } from '../../context/AuthContext';
import { useIsMobile } from '../../hooks/useIsMobile';
import { LIFETIME_STATE_COPY as COPY } from '../../lib/betaCopy';
import { BETA_TERMS_URL } from '../../lib/legal';
import ResidenceStateForm from './ResidenceStateForm';

const REDUCED_KEY = 'vernal.lifetimeStateBanner.reduced';
const FADE_MS = 300;
const TOAST_MS = 3000;

interface Props {
  // Same contract as GuestBanner: true → position:fixed at `top`; false →
  // normal flow under whatever precedes it.
  fixed: boolean;
  top: string;
  // Rendered height in px (0 while hidden). AppShell adds it to --shell-top.
  onHeightChange: (px: number) => void;
}

// idle: showing. fading: saved, fading out. done: saved, no longer rendered.
type Phase = 'idle' | 'fading' | 'done';

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

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

// After the banner goes, focus lands on the page heading rather than <body>.
function focusFirstHeading(): void {
  const h1 = document.querySelector('h1');
  if (!h1) return;
  if (!h1.hasAttribute('tabindex')) h1.tabIndex = -1;
  h1.focus({ preventScroll: true });
}

function PinIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
      <circle cx="12" cy="10" r="3" />
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

const SECONDARY_BUTTON: CSSProperties = {
  ...BUTTON_BASE,
  border: 'none',
  background: 'transparent',
  color: 'var(--c-text-2)',
};

export default function LifetimeStateBanner({ fixed, top, onHeightChange }: Props) {
  const { state, refetch } = useAuth();
  const isMobile = useIsMobile();

  const [reduced, setReduced] = useState(readReduced);
  const [phase, setPhase] = useState<Phase>('idle');
  const [toast, setToast] = useState(false);
  const [el, setEl] = useState<HTMLElement | null>(null);
  const timers = useRef<number[]>([]);
  // Set on the first save so a second onSaved (double-click during the fade) is ignored.
  const savedRef = useRef(false);

  const asked =
    state.kind === 'account' && state.account.lifetimeStateAsk && state.account.residenceState === null;

  // Once the refetch shows the answer, the banner is done for this account; a
  // later account that still needs asking starts fresh.
  useEffect(() => {
    if (!asked) {
      savedRef.current = false;
      setPhase('idle');
    }
  }, [asked]);

  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);

  const visible = asked && phase !== 'done';

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

  function reduce() {
    writeReduced(true);
    setReduced(true);
  }

  function restore() {
    writeReduced(false);
    setReduced(false);
  }

  function onSaved() {
    if (savedRef.current) return;
    savedRef.current = true;
    setPhase('fading');
    timers.current.push(
      window.setTimeout(() => {
        setPhase('done');
        setToast(true);
        focusFirstHeading();
        refetch().catch(() => {});
        timers.current.push(window.setTimeout(() => setToast(false), TOAST_MS));
      }, prefersReducedMotion() ? 0 : FADE_MS),
    );
  }

  // The live region is always mounted (empty when idle) so the text is announced when it appears.
  const toastEl = (
    <div
      key="toast"
      role="status"
      style={{
        position: 'fixed',
        left: '50%',
        transform: 'translateX(-50%)',
        bottom: 'calc(var(--shell-bottom, 0px) + var(--sp-4) + var(--deletion-banner-h, 0px))',
        zIndex: 1060,
        ...(toast
          ? {
              padding: 'var(--sp-3) var(--sp-5)',
              background: 'var(--c-surface)',
              color: 'var(--c-text)',
              border: '1px solid var(--c-border-subtle)',
              borderRadius: 'var(--r-full)',
              boxShadow: 'var(--shadow-lg)',
              fontFamily: 'var(--font-ui)',
              fontSize: 14,
              fontWeight: 600,
              whiteSpace: 'nowrap',
            }
          : {}),
      }}
    >
      {toast ? COPY.toast : null}
    </div>
  );

  // Nothing at all for anyone not being asked, unless the toast is still up.
  if (!visible) return asked || toast ? <>{toastEl}</> : null;

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
      @keyframes vernal-ls-in { from { transform: translateY(-100%); } to { transform: none; } }
      @keyframes vernal-ls-collapse { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: none; } }
      @keyframes vernal-ls-reveal { from { clip-path: inset(0 0 100% 0); } to { clip-path: inset(0); } }
      .vernal-ls-banner { animation: vernal-ls-in 250ms ease-out; transition: opacity ${FADE_MS}ms ease-out; }
      .vernal-ls-banner[data-flow] { animation-name: vernal-ls-reveal; }
      .vernal-ls-banner[data-fading] { opacity: 0; }
      .vernal-ls-chip { animation: vernal-ls-collapse 200ms ease-out; }
      @media (prefers-reduced-motion: reduce) {
        .vernal-ls-banner, .vernal-ls-chip { animation: none; transition: none; }
      }
    `}</style>
  );

  if (reduced) {
    return (
      <>
        <section
          ref={setEl}
          aria-label={COPY.region}
          data-testid="lifetime-state-banner"
          data-state="reduced"
          className="vernal-ls-chip"
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
            data-testid="lifetime-state-chip"
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
            <PinIcon />
            {COPY.chip}
          </button>
        </section>
        {toastEl}
      </>
    );
  }

  return (
    <>
      <section
        ref={setEl}
        role="region"
        aria-label={COPY.region}
        data-testid="lifetime-state-banner"
        data-state="prominent"
        className="vernal-ls-banner"
        data-flow={fixed ? undefined : ''}
        data-fading={phase === 'fading' ? '' : undefined}
        style={{
          ...wrapperStyle,
          display: 'flex',
          flexDirection: isMobile ? 'column' : 'row',
          flexWrap: isMobile ? undefined : 'wrap',
          alignItems: isMobile ? 'stretch' : 'center',
          gap: isMobile ? 'var(--sp-2)' : 'var(--sp-4)',
          padding: isMobile ? 'var(--sp-2) var(--sp-3)' : 'var(--sp-2) var(--sp-6)',
          minHeight: isMobile ? undefined : 52,
          background: 'var(--c-primary-subtle)',
          borderBottom: '1px solid var(--c-border-subtle)',
        }}
      >
        {styleTag}
        <p
          style={{
            flex: isMobile ? undefined : '1 1 240px',
            minWidth: 0,
            margin: 0,
            fontSize: isMobile ? 13 : 14,
            lineHeight: 1.4,
          }}
        >
          {COPY.line}
        </p>
        <ResidenceStateForm
          initial={null}
          onSaved={onSaved}
          layout="banner"
          isMobile={isMobile}
          secondary={
            <button
              type="button"
              data-testid="lifetime-state-not-now"
              onClick={reduce}
              style={{ ...SECONDARY_BUTTON, ...(isMobile ? { flex: 1 } : {}) }}
            >
              {COPY.notNow}
            </button>
          }
        />
        <a
          href={BETA_TERMS_URL}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            minHeight: 44,
            fontSize: 13,
            color: 'var(--c-primary-dark)',
            textDecoration: 'underline',
            alignSelf: isMobile ? 'flex-start' : undefined,
          }}
        >
          {COPY.about}
        </a>
      </section>
      {toastEl}
    </>
  );
}
