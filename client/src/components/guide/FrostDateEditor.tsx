import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { patch } from '../../lib/api';
import { FROST_COPY } from '../../lib/frostLabels';
import BottomSheet from '../shell/BottomSheet';
import { inputSt, labelSt } from '../account/settingsStyles';
import { primaryButtonStyle, textButtonStyle } from './styles';

interface Props {
  initial: string | null;
  isMobile: boolean;
  onSaved: () => void;
  onCancel: () => void;
}

const panelStyle: CSSProperties = {
  background: 'var(--c-surface)',
  border: '1px solid var(--c-border)',
  borderRadius: 'var(--r-md)',
  padding: 'var(--sp-3)',
};

// Sets the account's last spring frost date from the Planting Guide. An inline
// panel on desktop, a bottom sheet on mobile.
export default function FrostDateEditor({ initial, isMobile, onSaved, onCancel }: Props) {
  const inputId = useId();
  const hintId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initial ?? '');
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!value || saving) return;
    setFailed(false);
    setSaving(true);
    try {
      await patch('/api/me', { lastSpringFrostDate: value });
    } catch {
      setFailed(true);
      setSaving(false);
      return;
    }
    setSaving(false);
    onSaved();
  }

  const body = (
    <form onSubmit={(e) => void save(e)} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)', fontFamily: 'var(--font-ui)' }}>
      <div>
        <label htmlFor={inputId} style={labelSt}>{FROST_COPY.editorLabel}</label>
        <input
          ref={inputRef}
          id={inputId}
          type="date"
          value={value}
          aria-describedby={hintId}
          onChange={(e) => setValue(e.target.value)}
          style={{ ...inputSt, maxWidth: 240 }}
        />
      </div>
      <p id={hintId} style={{ margin: 0, fontSize: 13, color: 'var(--c-text-2)' }}>{FROST_COPY.editorHint}</p>
      {failed && (
        <p role="alert" style={{ margin: 0, fontSize: 13, color: 'var(--c-danger)' }}>{FROST_COPY.saveFailed}</p>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--sp-2)' }}>
        <button
          type="submit"
          disabled={!value || saving}
          style={{ ...primaryButtonStyle, opacity: !value || saving ? 0.6 : 1, cursor: !value || saving ? 'default' : 'pointer' }}
        >
          {FROST_COPY.save}
        </button>
        <button type="button" onClick={onCancel} style={textButtonStyle}>
          {FROST_COPY.cancel}
        </button>
      </div>
    </form>
  );

  if (isMobile) {
    return (
      <BottomSheet open title={FROST_COPY.editorLabel} onClose={onCancel}>
        <div style={{ padding: 'var(--sp-2) var(--sp-4) var(--sp-4)' }}>{body}</div>
      </BottomSheet>
    );
  }

  return <div style={panelStyle}>{body}</div>;
}
