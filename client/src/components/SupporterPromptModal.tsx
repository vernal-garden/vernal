import { useEffect } from 'react';

interface Props {
  open: boolean;
  onClose: () => void;
  onLearnMore: () => void;
}

// ED: replace with final headline
const HEADLINE = 'Support the garden that helps you grow';

// ED: replace with final body copy
const BODY =
  "Vernal is free to use. A Supporter subscription keeps it running " +
  '— and unlocks photo journaling, PDF exports, soil chemistry, and more. ' +
  "Take a look when you're ready.";

export default function SupporterPromptModal({ open, onClose, onLearnMore }: Props) {
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 400,
        background: 'rgba(42,35,24,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '0 16px',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          position: 'relative',
          background: 'var(--c-surface)', borderRadius: 'var(--r-xl)',
          boxShadow: 'var(--shadow-lg)', width: '100%', maxWidth: 440,
          padding: 'var(--sp-6)', fontFamily: 'var(--font-ui)',
          textAlign: 'center',
          animation: 'supporter-prompt-fade-in 0.18s ease',
        }}
        role="dialog"
        aria-modal="true"
        aria-label="Supporter prompt"
        onClick={e => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          style={{
            position: 'absolute', top: 'var(--sp-3)', right: 'var(--sp-3)',
            width: 28, height: 28, borderRadius: 'var(--r-full)',
            border: 'none', background: 'transparent', color: 'var(--c-text-3)',
            fontSize: 18, lineHeight: 1, cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          ×
        </button>

        <div style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 56, height: 56, borderRadius: 'var(--r-full)',
          background: 'var(--c-primary-subtle)', marginBottom: 'var(--sp-4)',
        }}>
          <span style={{ fontSize: 24 }}>🌱</span>
        </div>

        <h2 style={{
          margin: '0 0 var(--sp-3)',
          fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 600,
          color: 'var(--c-text)',
        }}>
          {HEADLINE}
        </h2>

        <p style={{
          margin: '0 0 var(--sp-5)',
          fontFamily: 'var(--font-ui)', fontSize: 14, color: 'var(--c-text-2)',
          lineHeight: 1.6,
        }}>
          {BODY}
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}>
          <button
            type="button"
            onClick={onLearnMore}
            style={{
              padding: '10px 24px', fontSize: 14, fontFamily: 'var(--font-ui)',
              fontWeight: 600, border: 'none', borderRadius: 'var(--r-md)',
              background: 'var(--c-primary)', color: 'var(--c-text-on-primary)',
              cursor: 'pointer',
            }}
          >
            Learn about Supporter
          </button>
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: '9px 18px', background: 'transparent', color: 'var(--c-text-2)',
              border: 'none', borderRadius: 'var(--r-md)',
              fontFamily: 'var(--font-ui)', fontSize: 14, cursor: 'pointer',
            }}
          >
            Not now
          </button>
        </div>
      </div>
      <style>{`@keyframes supporter-prompt-fade-in { from { opacity: 0 } to { opacity: 1 } }`}</style>
    </div>
  );
}
