// client/src/components/catalogue/ContributeModal.tsx
import { useEffect, useState } from 'react';
import { post } from '../../lib/api';
import type { PersonalSeedDetail } from '../../types/catalogue';

interface Props {
  seed: PersonalSeedDetail;
  onClose: () => void;
  onContributed: () => void;
}

function PreviewRow({ label, value }: { label: string; value: string | number | null | undefined }) {
  if (value == null || value === '') return null;
  return (
    <div style={{ display: 'flex', gap: 'var(--sp-3)', paddingBottom: 'var(--sp-1)' }}>
      <span style={{ fontSize: 13, color: 'var(--c-text-3)', minWidth: 140, fontFamily: 'var(--font-ui)' }}>{label}</span>
      <span style={{ fontSize: 13, color: 'var(--c-text)', fontFamily: 'var(--font-ui)', fontWeight: 500 }}>{String(value)}</span>
    </div>
  );
}

export default function ContributeModal({ seed, onClose, onContributed }: Props) {
  const [status, setStatus] = useState<'idle' | 'saving' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function handleSubmit() {
    setStatus('saving');
    setErrorMsg('');
    try {
      await post(`/api/seeds/${seed.id}/contribute`, { includePhotos: false });
      onContributed();
      onClose();
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
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          background: 'var(--c-surface)', borderRadius: 'var(--r-xl)',
          boxShadow: 'var(--shadow-lg)', width: '100%', maxWidth: 520,
          padding: 'var(--sp-6)', fontFamily: 'var(--font-ui)',
          animation: 'catalogue-fade-in 0.18s ease',
        }}
        role="dialog"
        aria-modal="true"
        aria-label="Contribute to Cambium"
        onClick={e => e.stopPropagation()}
      >
        <h2 style={{ margin: '0 0 var(--sp-2)', fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 600, color: 'var(--c-text)' }}>
          Contribute to Cambium
        </h2>
        <p style={{ margin: '0 0 var(--sp-4)', fontSize: 14, color: 'var(--c-text-2)' }}>
          The following data will be shared with the Cambium community. It will be reviewed before being published.
        </p>

        {/* Data preview */}
        <div style={{ background: 'var(--c-surface-raised)', borderRadius: 'var(--r-md)', padding: 'var(--sp-4)', marginBottom: 'var(--sp-4)', border: '1px solid var(--c-border-subtle)' }}>
          <PreviewRow label="Common name" value={seed.commonName} />
          <PreviewRow label="Scientific name" value={seed.scientificName} />
          <PreviewRow label="Plant family" value={seed.plantFamily} />
          <PreviewRow label="Spacing (in)" value={seed.spacingInches} />
          <PreviewRow label="Maturity (days)" value={
            seed.maturityDaysMin != null || seed.maturityDaysMax != null
              ? [seed.maturityDaysMin, seed.maturityDaysMax].filter(v => v != null).join('\u2013')
              : null
          } />
          <PreviewRow label="Sunlight" value={seed.sunlight} />
          <PreviewRow label="Watering" value={seed.wateringNeeds} />
          <PreviewRow label="Frost tolerance" value={seed.frostTolerance} />
          {seed.tags && seed.tags.length > 0 && (
            <PreviewRow label="Tags" value={seed.tags.join(', ')} />
          )}
        </div>

        <div style={{
          fontSize: 13, color: 'var(--c-text-3)', padding: 'var(--sp-3)',
          background: 'var(--c-surface-inset)', borderRadius: 'var(--r-md)',
          marginBottom: 'var(--sp-4)', border: '1px solid var(--c-border-subtle)',
        }}>
          Your personal notes and planting history will not be shared.
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
            disabled={status === 'saving'}
            style={{
              padding: '9px 18px', background: 'var(--c-primary)', color: 'var(--c-text-on-primary)',
              border: 'none', borderRadius: 'var(--r-md)',
              fontFamily: 'var(--font-ui)', fontSize: 14, fontWeight: 600,
              cursor: status !== 'saving' ? 'pointer' : 'default',
              opacity: status !== 'saving' ? 1 : 0.6,
            }}
          >
            {status === 'saving' ? 'Submitting\u2026' : 'Submit to Cambium'}
          </button>
        </div>
      </div>
    </div>
  );
}
