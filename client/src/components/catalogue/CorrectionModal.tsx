// client/src/components/catalogue/CorrectionModal.tsx
import { useEffect, useRef, useState } from 'react';
import { post } from '../../lib/api';

interface Props {
  cambiumSeedId: string;
  seedName: string;
  onClose: () => void;
}

export default function CorrectionModal({ cambiumSeedId, seedName, onClose }: Props) {
  const [text, setText] = useState('');
  const [status, setStatus] = useState<'idle' | 'saving' | 'done' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { textareaRef.current?.focus(); }, []);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape' && status !== 'done') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, status]);

  // Auto-close 1.5s after success
  useEffect(() => {
    if (status !== 'done') return;
    const t = setTimeout(() => onClose(), 1500);
    return () => clearTimeout(t);
  }, [status, onClose]);

  async function handleSubmit() {
    if (!text.trim()) return;
    setStatus('saving');
    setErrorMsg('');
    try {
      await post('/api/corrections', { cambiumSeedId, correctionText: text.trim() });
      setStatus('done');
    } catch (err: unknown) {
      const body = (err as { body?: { error?: string } })?.body;
      setErrorMsg(body?.error ?? 'Failed to submit. Please try again.');
      setStatus('error');
    }
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 400,
        background: 'rgba(42,35,24,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '0 16px',
      }}
      onClick={(e) => { if (e.target === e.currentTarget && status !== 'done') onClose(); }}
    >
      <div
        style={{
          background: 'var(--c-surface)', borderRadius: 'var(--r-xl)',
          boxShadow: 'var(--shadow-lg)', width: '100%', maxWidth: 480,
          padding: 'var(--sp-6)', fontFamily: 'var(--font-ui)',
          animation: 'catalogue-fade-in 0.18s ease',
        }}
        role="dialog"
        aria-modal="true"
        aria-label="Suggest a correction"
        onClick={e => e.stopPropagation()}
      >
        <h2 style={{ margin: '0 0 var(--sp-2)', fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 600, color: 'var(--c-text)' }}>
          Suggest a correction
        </h2>
        <p style={{ margin: '0 0 var(--sp-4)', fontSize: 14, color: 'var(--c-text-2)' }}>
          Seed: <strong>{seedName}</strong>
        </p>

        {status === 'done' ? (
          <div style={{
            textAlign: 'center', padding: 'var(--sp-6)',
            color: 'var(--c-success)', fontWeight: 600, fontSize: 15,
          }}>
            Correction submitted. Thank you!
          </div>
        ) : (
          <>
            <textarea
              ref={textareaRef}
              value={text}
              onChange={e => setText(e.target.value.slice(0, 2000))}
              rows={5}
              placeholder="Describe the correction\u2026"
              style={{
                width: '100%', boxSizing: 'border-box',
                padding: 'var(--sp-3)', fontFamily: 'var(--font-ui)', fontSize: 14,
                color: 'var(--c-text)', background: 'var(--c-surface-inset)',
                border: '1px solid var(--c-border)', borderRadius: 'var(--r-md)',
                resize: 'vertical', outline: 'none', marginBottom: 'var(--sp-1)',
              }}
            />
            <div style={{ fontSize: 11, color: 'var(--c-text-3)', marginBottom: 'var(--sp-3)' }}>
              {text.length}/2000
            </div>

            {status === 'error' && (
              <div style={{ fontSize: 13, color: 'var(--c-danger)', marginBottom: 'var(--sp-3)' }}>{errorMsg}</div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--sp-2)' }}>
              <button
                type="button"
                onClick={onClose}
                style={{
                  padding: '9px 18px', background: 'transparent', color: 'var(--c-text-2)',
                  border: '1px solid var(--c-border)', borderRadius: 'var(--r-md)',
                  fontFamily: 'var(--font-ui)', fontSize: 14, cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={!text.trim() || status === 'saving'}
                style={{
                  padding: '9px 18px', background: 'var(--c-primary)', color: 'var(--c-text-on-primary)',
                  border: 'none', borderRadius: 'var(--r-md)',
                  fontFamily: 'var(--font-ui)', fontSize: 14, fontWeight: 600,
                  cursor: text.trim() && status !== 'saving' ? 'pointer' : 'default',
                  opacity: text.trim() && status !== 'saving' ? 1 : 0.6,
                }}
              >
                {status === 'saving' ? 'Submitting\u2026' : 'Submit'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
