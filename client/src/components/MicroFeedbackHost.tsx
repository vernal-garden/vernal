import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import {
  PROMPTS,
  sendMicroFeedback,
  sendMicroFeedbackComment,
  setMicroFeedbackListener,
  type MicroFeedbackTrigger,
} from '../lib/microFeedback';
import { CloseIcon } from './shell/icons';
import { iconButtonStyle, primaryButtonStyle, textButtonStyle } from './guide/styles';

// The micro-feedback card (Feedback Pipeline spec 3.2). A card, not a modal:
// it sits bottom-right above the feedback button and never blocks the page.
// Rendered once, in AppShell.

const AUTO_DISMISS_MS = 30_000;
const THANKS_MS = 2000;
const SEND_ERROR = "Couldn't send — try again.";

type Phase = 'ask' | 'comment' | 'thanks';

interface Active {
  trigger: MicroFeedbackTrigger;
  pathname: string;
}

export default function MicroFeedbackHost() {
  const { pathname } = useLocation();
  const [active, setActive] = useState<Active | null>(null);
  const [phase, setPhase] = useState<Phase>('ask');
  const [text, setText] = useState('');
  const [responseId, setResponseId] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;
  const idleTimer = useRef<number | undefined>(undefined);
  const thanksTimer = useRef<number | undefined>(undefined);

  function close() {
    window.clearTimeout(idleTimer.current);
    window.clearTimeout(thanksTimer.current);
    setActive(null);
  }

  useEffect(
    () =>
      setMicroFeedbackListener((trigger) => {
        setPhase('ask');
        setText('');
        setResponseId(null);
        setError(null);
        setSending(false);
        setActive({ trigger, pathname: pathnameRef.current });
      }),
    [],
  );

  // Auto-dismiss after 30 seconds unless the user interacts.
  useEffect(() => {
    if (!active) return;
    idleTimer.current = window.setTimeout(() => setActive(null), AUTO_DISMISS_MS);
    return () => window.clearTimeout(idleTimer.current);
  }, [active]);

  // Leaving the page dismisses it.
  useEffect(() => {
    if (active && pathname !== active.pathname) {
      window.clearTimeout(thanksTimer.current);
      setActive(null);
    }
  }, [pathname, active]);

  useEffect(() => () => window.clearTimeout(thanksTimer.current), []);

  if (!active) return null;

  const prompt = PROMPTS[active.trigger];

  function interacted() {
    window.clearTimeout(idleTimer.current);
  }

  function thank() {
    setPhase('thanks');
    thanksTimer.current = window.setTimeout(() => setActive(null), THANKS_MS);
  }

  async function sendThumbs(value: 'thumbs_up' | 'thumbs_down') {
    if (!active || sending) return;
    setSending(true);
    setError(null);
    try {
      const id = await sendMicroFeedback(active.trigger, value);
      setResponseId(id);
      setPhase('comment');
    } catch {
      setError(SEND_ERROR);
    } finally {
      setSending(false);
    }
  }

  async function sendText() {
    const trimmed = text.trim();
    if (!active || sending || !trimmed) return;
    setSending(true);
    setError(null);
    try {
      if (prompt.type === 'text') await sendMicroFeedback(active.trigger, trimmed);
      else if (responseId !== null) await sendMicroFeedbackComment(responseId, trimmed);
      thank();
    } catch {
      setError(SEND_ERROR);
    } finally {
      setSending(false);
    }
  }

  const showTextarea = prompt.type === 'text' || phase === 'comment';

  return (
    <div
      role="region"
      aria-label="Quick question"
      aria-live="polite"
      className="vernal-mf-card"
      onPointerDown={interacted}
      onKeyDown={interacted}
      onFocus={interacted}
      style={{
        position: 'fixed',
        right: 16,
        bottom: 'calc(var(--shell-bottom, 0px) + 88px)',
        width: 'min(360px, 100vw - 32px)',
        boxSizing: 'border-box',
        zIndex: 1060,
        background: 'var(--c-surface)',
        color: 'var(--c-text)',
        border: '1px solid var(--c-border)',
        borderRadius: 'var(--r-lg)',
        boxShadow: 'var(--shadow-lg)',
        padding: 'var(--sp-2) var(--sp-2) var(--sp-4) var(--sp-4)',
        fontFamily: 'var(--font-ui)',
      }}
    >
      <style>{`
        @keyframes vernal-mf-up { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }
        .vernal-mf-card { animation: vernal-mf-up 150ms ease-out; }
        @media (prefers-reduced-motion: reduce) { .vernal-mf-card { animation: none; } }
      `}</style>

      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--sp-2)' }}>
        <p style={{ flex: 1, margin: 'var(--sp-3) 0 0', fontSize: 15, fontWeight: 600, lineHeight: 1.4 }}>
          {phase === 'thanks' ? 'Thanks.' : prompt.question}
        </p>
        <button type="button" aria-label="Dismiss" onClick={close} style={iconButtonStyle}>
          <CloseIcon />
        </button>
      </div>

      {phase === 'ask' && prompt.type === 'thumbs' && (
        <div style={{ display: 'flex', gap: 'var(--sp-2)', marginTop: 'var(--sp-3)', paddingRight: 'var(--sp-2)' }}>
          <button
            type="button"
            aria-label="Thumbs up"
            disabled={sending}
            onClick={() => void sendThumbs('thumbs_up')}
            style={{ ...textButtonStyle, flex: 1, fontSize: 20 }}
          >
            <span aria-hidden="true">👍</span>
          </button>
          <button
            type="button"
            aria-label="Thumbs down"
            disabled={sending}
            onClick={() => void sendThumbs('thumbs_down')}
            style={{ ...textButtonStyle, flex: 1, fontSize: 20 }}
          >
            <span aria-hidden="true">👎</span>
          </button>
        </div>
      )}

      {phase !== 'thanks' && showTextarea && (
        <div style={{ marginTop: 'var(--sp-3)', paddingRight: 'var(--sp-2)' }}>
          {phase === 'comment' && (
            <label htmlFor="vernal-mf-text" style={{ display: 'block', fontSize: 13, color: 'var(--c-text-2)', marginBottom: 'var(--sp-2)' }}>
              Want to say more? (optional)
            </label>
          )}
          <textarea
            id="vernal-mf-text"
            aria-label={phase === 'comment' ? undefined : prompt.question}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={prompt.type === 'text' ? 'Anything is helpful.' : undefined}
            rows={3}
            maxLength={2000}
            style={{
              display: 'block',
              width: '100%',
              boxSizing: 'border-box',
              padding: 'var(--sp-2) var(--sp-3)',
              border: '1px solid var(--c-border)',
              borderRadius: 'var(--r-md)',
              background: 'var(--c-surface)',
              color: 'var(--c-text)',
              fontFamily: 'inherit',
              fontSize: 14,
              resize: 'vertical',
            }}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--sp-2)', marginTop: 'var(--sp-3)' }}>
            <button type="button" onClick={close} style={textButtonStyle}>
              {prompt.type === 'text' ? 'No thanks' : 'Skip'}
            </button>
            <button
              type="button"
              onClick={() => void sendText()}
              disabled={sending || !text.trim()}
              style={{ ...primaryButtonStyle, opacity: sending || !text.trim() ? 0.5 : 1 }}
            >
              {sending ? 'Sending…' : 'Send'}
            </button>
          </div>
        </div>
      )}

      {error && (
        <p role="alert" style={{ margin: 'var(--sp-2) 0 0', fontSize: 13, color: 'var(--c-danger)' }}>
          {error}
        </p>
      )}
    </div>
  );
}
