import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { Planting, StartMethod } from '../../hooks/usePlantings';
import { useIsMobile } from '../../hooks/useIsMobile';
import { apiErrorMessage } from '../../lib/api';
import { todayPacific } from '../../lib/guideDates';
import { groupPlannedByPlant, saveButtonState } from '../../lib/markStarted';
import { PLANTING_DATE_LABEL, SHEET_TITLE } from '../../lib/planningStrings';
import BottomSheet from '../shell/BottomSheet';
import { inputSt, labelSt } from '../account/settingsStyles';
import { primaryButtonStyle } from '../guide/styles';
import StartMethodControl from './StartMethodControl';

interface Props {
  plantings: Planting[];
  onSave: (ids: string[], startMethod: StartMethod, date: string) => Promise<void>;
  onClose: () => void;
}

const SAVE_FAILED = "Couldn't save. Try again.";

const rowStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 'var(--sp-3)', minHeight: 44,
  padding: '0 var(--sp-2)', cursor: 'pointer', fontFamily: 'var(--font-ui)',
  fontSize: 14, color: 'var(--c-text)',
};

// Marks a bed's planned plantings as in the ground, grouped by plant. A
// centred dialog on desktop, a bottom sheet under the phone breakpoint.
export default function MarkStartedSheet({ plantings, onSave, onClose }: Props) {
  const isMobile = useIsMobile();
  const titleId = useId();
  const dateId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const groups = useMemo(() => groupPlannedByPlant(plantings), [plantings]);
  const [unchecked, setUnchecked] = useState<Set<string>>(() => new Set());
  const [startMethod, setStartMethod] = useState<StartMethod>(() => groups[0]?.startMethod ?? 'sown');
  const [date, setDate] = useState(() => todayPacific());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const checkedGroups = groups.map(g => ({ ...g, checked: !unchecked.has(g.key) }));
  const button = saveButtonState(checkedGroups);
  const disabled = button.disabled || !date || saving;

  // Desktop dialog: focus in on open, back to the trigger on close, Escape closes.
  // (On phones BottomSheet does the same.)
  useEffect(() => {
    if (isMobile) return;
    const trigger = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (trigger?.isConnected) trigger.focus?.();
    };
  }, [isMobile]);

  function toggle(key: string) {
    setUnchecked(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  async function save() {
    if (disabled) return;
    const ids = checkedGroups.filter(g => g.checked).flatMap(g => g.plantingIds);
    setError(null);
    setSaving(true);
    try {
      await onSave(ids, startMethod, date);
    } catch (e) {
      setError(apiErrorMessage(e, SAVE_FAILED));
      setSaving(false);
      return;
    }
    setSaving(false);
    onClose();
  }

  const body = (
    <form
      onSubmit={(e) => { e.preventDefault(); void save(); }}
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)', fontFamily: 'var(--font-ui)' }}
    >
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {groups.map(g => (
          <label key={g.key} style={rowStyle}>
            <input
              type="checkbox"
              checked={!unchecked.has(g.key)}
              onChange={() => toggle(g.key)}
              style={{ width: 20, height: 20, flexShrink: 0, accentColor: 'var(--c-primary)' }}
            />
            <span style={{ flex: 1, minWidth: 0 }}>{g.name}</span>
            <span style={{ color: 'var(--c-text-2)' }}>{g.quantity}</span>
          </label>
        ))}
      </div>
      <StartMethodControl value={startMethod} onChange={setStartMethod} disabled={saving} />
      <div>
        <label htmlFor={dateId} style={labelSt}>{PLANTING_DATE_LABEL}</label>
        <input
          id={dateId}
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          style={{ ...inputSt, minHeight: 44, maxWidth: 240 }}
        />
      </div>
      {error && (
        <p role="alert" style={{ margin: 0, fontSize: 13, color: 'var(--c-danger)' }}>{error}</p>
      )}
      <button
        type="submit"
        disabled={disabled}
        style={{ ...primaryButtonStyle, opacity: disabled ? 0.6 : 1, cursor: disabled ? 'default' : 'pointer' }}
      >
        {button.label}
      </button>
    </form>
  );

  if (isMobile) {
    return (
      <BottomSheet open title={SHEET_TITLE} onClose={onClose}>
        <div style={{ padding: 'var(--sp-2) var(--sp-4) var(--sp-4)' }}>{body}</div>
      </BottomSheet>
    );
  }

  return (
    <>
      <div
        aria-hidden="true"
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, zIndex: 40, background: 'rgba(42,35,24,0.4)' }}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={{
          position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
          zIndex: 41, width: 'min(420px, calc(100vw - 32px))', maxHeight: '90dvh', overflowY: 'auto',
          background: 'var(--c-surface)', border: '1px solid var(--c-border)',
          borderRadius: 'var(--r-lg)', boxShadow: 'var(--shadow-lg)',
          padding: 'var(--sp-4)', outline: 'none',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)', marginBottom: 'var(--sp-3)' }}>
          <h2
            id={titleId}
            style={{ flex: 1, margin: 0, fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 600, color: 'var(--c-text)' }}
          >
            {SHEET_TITLE}
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            style={{
              width: 44, height: 44, flexShrink: 0, padding: 0, border: 'none',
              borderRadius: 'var(--r-full)', background: 'transparent',
              color: 'var(--c-text-2)', fontSize: 20, cursor: 'pointer',
            }}
          >
            ×
          </button>
        </div>
        {body}
      </div>
    </>
  );
}
