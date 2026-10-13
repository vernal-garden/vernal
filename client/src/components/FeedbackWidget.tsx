import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import * as api from '../lib/api';
import { ApiError } from '../lib/api';
import { useCanvasMounted } from '../context/CanvasPresenceContext';
import router from '../routes';

// Persistent feedback widget — surface 3.1 of the Feedback Pipeline spec.

type Category = 'bug' | 'feature_request' | 'general';

const CHIPS: { value: Category; emoji: string; label: string; hint: string }[] = [
  { value: 'bug', emoji: '🐛', label: 'Bug', hint: "Something's broken" },
  { value: 'feature_request', emoji: '💡', label: 'Idea', hint: 'Feature or improvement' },
  { value: 'general', emoji: '💬', label: 'Other', hint: 'Anything else' },
];

// Full-screen flows where the FAB would be disruptive.
const HIDDEN_PATHS = new Set([
  '/onboarding',
  '/login',
  '/register',
  '/reset-password',
  '/session-expired',
  '/connection-problem',
]);

// Route → source_surface identifier attached to every submission.
function sourceSurfaceFor(pathname: string): string {
  if (pathname === '/') return 'canvas';
  if (pathname === '/catalogue') return 'seed_catalogue';
  if (pathname === '/guide') return 'planting_guide';
  if (pathname === '/data') return 'metrics_dashboard';
  if (pathname === '/account' || pathname.startsWith('/account/')) return 'account_settings';
  if (pathname === '/gardens') return 'my_gardens';
  if (pathname === '/weather') return 'weather';
  if (/^\/garden\/[^/]+\/soil$/.test(pathname)) return 'soil';
  if (/^\/garden\/[^/]+\/amendments$/.test(pathname)) return 'amendments';
  return 'other';
}

const MIN_LENGTH = 10;
const MAX_LENGTH = 5000;
const SUCCESS_CLOSE_MS = 2000;
const NARROW_QUERY = '(max-width: 1023px)';

const FAB_SIZE = 48;
const EDGE = 'var(--sp-5)';
const NETWORK_ERROR = "Couldn't send — check your connection and try again.";

// The widget lives outside <RouterProvider>, so it reads location from the
// router instance instead of useLocation().
function usePathname(): string {
  return useSyncExternalStore(
    (onChange) => router.subscribe(onChange),
    () => router.state.location.pathname,
  );
}

function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(query);
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    },
    () => window.matchMedia(query).matches,
  );
}

function SpeechBubbleIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.6A8 8 0 1 1 21 12z" />
    </svg>
  );
}

interface Props {
  // Extra clearance above the bottom edge (e.g. while the update banner is showing).
  bottomOffset?: number;
}

export default function FeedbackWidget({ bottomOffset = 0 }: Props) {
  const pathname = usePathname();
  const canvasMounted = useCanvasMounted();
  const isNarrow = useMediaQuery(NARROW_QUERY);

  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<Category | null>(null);
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'success'>('idle');
  const [error, setError] = useState('');
  // Once-per-category-per-session guard — in memory only, by design.
  const [sentCategories, setSentCategories] = useState<Set<Category>>(() => new Set());

  const rootRef = useRef<HTMLDivElement>(null);
  const fabRef = useRef<HTMLButtonElement>(null);
  const closeTimer = useRef<number | undefined>(undefined);

  const hidden = HIDDEN_PATHS.has(pathname);

  function close() {
    window.clearTimeout(closeTimer.current);
    setOpen(false);
    setError('');
    if (status === 'success') {
      setStatus('idle');
      setCategory(null);
      setMessage('');
    }
  }

  // Escape and click-outside both dismiss without submitting.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        close();
        fabRef.current?.focus();
      }
    }
    function onPointer(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close();
    }
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  });

  // Navigating to a hidden flow closes the panel.
  useEffect(() => {
    if (hidden && open) close();
  });

  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  if (hidden) return null;

  const onLeft = canvasMounted && isNarrow;
  const side = onLeft ? { left: EDGE } : { right: EDGE };
  const fabBottom = `calc(${EDGE} + var(--shell-bottom, 0px) + ${bottomOffset}px)`;
  const panelBottom = `calc(${EDGE} + var(--shell-bottom, 0px) + ${bottomOffset}px + ${FAB_SIZE}px + var(--sp-2))`;

  const alreadySent = category !== null && sentCategories.has(category);
  const canSend =
    category !== null && !alreadySent && message.trim().length >= MIN_LENGTH && status === 'idle';

  async function submit() {
    if (!canSend || category === null) return;
    setStatus('sending');
    setError('');
    try {
      await api.post('/api/feedback', {
        category,
        message: message.trim(),
        sourceSurface: sourceSurfaceFor(pathname),
        appVersion: __APP_VERSION__,
      });
      setSentCategories((prev) => new Set(prev).add(category));
      setStatus('success');
      closeTimer.current = window.setTimeout(() => {
        setOpen(false);
        setStatus('idle');
        setCategory(null);
        setMessage('');
      }, SUCCESS_CLOSE_MS);
    } catch (err) {
      const body = err instanceof ApiError ? (err.body as { error?: unknown } | null) : null;
      setError(typeof body?.error === 'string' ? body.error : NETWORK_ERROR);
      setStatus('idle');
    }
  }

  return (
    <div ref={rootRef}>
      <style>{`
        @keyframes vernal-feedback-up { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
        @keyframes vernal-feedback-fade { from { opacity: 0; } to { opacity: 1; } }
      `}</style>

      {open && (
        <div
          role="dialog"
          aria-label="Send feedback"
          style={{
            position: 'fixed',
            bottom: panelBottom,
            ...side,
            zIndex: 40,
            width: `min(340px, calc(100vw - 2 * ${EDGE}))`,
            background: 'var(--c-surface)',
            color: 'var(--c-text)',
            border: '1px solid var(--c-border)',
            borderRadius: 'var(--r-lg)',
            boxShadow: 'var(--shadow-lg)',
            padding: 'var(--sp-4)',
            fontFamily: 'var(--font-ui)',
            animation: 'vernal-feedback-up 160ms ease-out',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--sp-3)' }}>
            <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Send feedback</h2>
            <button
              type="button"
              aria-label="Close"
              onClick={() => { close(); fabRef.current?.focus(); }}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'var(--c-text-3)', fontSize: 20, lineHeight: 1,
                padding: 'var(--sp-1)', borderRadius: 'var(--r-sm)',
              }}
            >
              ×
            </button>
          </div>

          {status === 'success' ? (
            <p
              role="status"
              style={{
                margin: 'var(--sp-4) 0', textAlign: 'center', fontSize: 14,
                color: 'var(--c-text-2)', animation: 'vernal-feedback-fade 200ms ease-out',
              }}
            >
              Got it — thanks.
            </p>
          ) : (
            <>
              <div role="radiogroup" aria-label="Category" style={{ display: 'flex', gap: 'var(--sp-2)' }}>
                {CHIPS.map((chip) => {
                  const selected = category === chip.value;
                  return (
                    <button
                      key={chip.value}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      title={chip.hint}
                      onClick={() => setCategory(chip.value)}
                      style={{
                        flex: 1,
                        display: 'flex', flexDirection: 'column', alignItems: 'center',
                        gap: 2,
                        padding: 'var(--sp-2) var(--sp-1)',
                        borderRadius: 'var(--r-md)',
                        border: `1px solid ${selected ? 'var(--c-text-2)' : 'var(--c-border)'}`,
                        background: selected ? 'var(--c-surface-raised)' : 'var(--c-surface)',
                        color: 'var(--c-text)',
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                      }}
                    >
                      <span style={{ fontSize: 13, fontWeight: 600 }}>
                        <span aria-hidden="true">{chip.emoji}</span> {chip.label}
                      </span>
                      <span style={{ fontSize: 11, color: 'var(--c-text-3)' }}>{chip.hint}</span>
                    </button>
                  );
                })}
              </div>

              {alreadySent && (
                <p style={{ margin: 'var(--sp-2) 0 0', fontSize: 12, color: 'var(--c-text-3)' }}>
                  Already sent one this session
                </p>
              )}

              <textarea
                aria-label="Feedback message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Describe what happened or what you'd like to see."
                rows={3}
                maxLength={MAX_LENGTH}
                style={{
                  display: 'block', width: '100%', boxSizing: 'border-box',
                  marginTop: 'var(--sp-3)',
                  padding: 'var(--sp-2) var(--sp-3)',
                  border: '1px solid var(--c-border)',
                  borderRadius: 'var(--r-md)',
                  background: 'var(--c-surface)',
                  color: 'var(--c-text)',
                  fontFamily: 'inherit', fontSize: 14,
                  resize: 'vertical',
                }}
              />

              {error && (
                <p role="alert" style={{ margin: 'var(--sp-2) 0 0', fontSize: 13, color: 'var(--c-danger)' }}>
                  {error}
                </p>
              )}

              <button
                type="button"
                onClick={submit}
                disabled={!canSend}
                style={{
                  display: 'block', width: '100%',
                  marginTop: 'var(--sp-3)',
                  padding: 'var(--sp-2) var(--sp-3)',
                  border: 'none',
                  borderRadius: 'var(--r-md)',
                  background: 'var(--c-primary)',
                  color: 'var(--c-text-on-primary)',
                  fontFamily: 'inherit', fontSize: 14, fontWeight: 600,
                  cursor: canSend ? 'pointer' : 'not-allowed',
                  opacity: canSend ? 1 : 0.5,
                }}
              >
                {status === 'sending' ? 'Sending…' : 'Send'}
              </button>
            </>
          )}
        </div>
      )}

      <button
        ref={fabRef}
        type="button"
        aria-label="Send feedback"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
        style={{
          position: 'fixed',
          bottom: fabBottom,
          ...side,
          zIndex: 40,
          width: FAB_SIZE,
          height: FAB_SIZE,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          borderRadius: 'var(--r-full)',
          border: '1px solid var(--c-border)',
          background: 'var(--c-surface)',
          color: 'var(--c-text-2)',
          boxShadow: 'var(--shadow-md)',
          cursor: 'pointer',
        }}
      >
        <SpeechBubbleIcon />
      </button>
    </div>
  );
}
