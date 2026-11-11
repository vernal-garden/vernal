import { useId, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import * as api from '../../lib/api';
import { LIFETIME_STATE_COPY as COPY } from '../../lib/betaCopy';
import { OUTSIDE_US, US_STATES, US_TERRITORIES } from '../../lib/usStates';

interface Props {
  initial: string | null;
  // Called with the saved answer once PUT /api/me/residence-state succeeds.
  onSaved: (state: string) => void;
  layout: 'banner' | 'row';
  isMobile: boolean;
  // A second button beside Save (the banner's "Not now"). On mobile it sits on
  // the left, so Save stays on the right.
  secondary?: ReactNode;
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
  cursor: 'pointer',
};

const PRIMARY_BUTTON: CSSProperties = {
  ...BUTTON_BASE,
  border: 'none',
  background: 'var(--c-primary)',
  color: 'var(--c-text-on-primary)',
};

const SEPARATOR = '──────────';

// The state picker shared by the lifetime-tier banner and the Subscription row.
// Nothing is preselected beyond the saved answer.
export default function ResidenceStateForm({ initial, onSaved, layout, isMobile, secondary }: Props) {
  const selectId = useId();
  const helperId = useId();
  const [value, setValue] = useState(initial ?? '');
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  async function save() {
    if (value === '' || saving) return;
    setSaving(true);
    setFailed(false);
    try {
      await api.put('/api/me/residence-state', { state: value });
      setSaving(false);
      onSaved(value);
    } catch {
      // Keep the choice so a retry is one press.
      setSaving(false);
      setFailed(true);
    }
  }

  const disabled = value === '' || saving;
  const saveButton = (
    <button
      type="button"
      onClick={() => void save()}
      disabled={disabled}
      style={{
        ...PRIMARY_BUTTON,
        ...(disabled ? { opacity: 0.5, cursor: 'not-allowed' } : {}),
        ...(isMobile && secondary ? { flex: 1 } : {}),
      }}
    >
      {COPY.save}
    </button>
  );

  // Mobile: one column, with the buttons side by side under the select (Save on
  // the right). Desktop: select and buttons in a row.
  const buttons = isMobile ? (
    <div style={{ display: 'flex', gap: 'var(--sp-2)' }}>
      {secondary}
      {saveButton}
    </div>
  ) : (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-1)', flexShrink: 0 }}>
      {saveButton}
      {secondary}
    </div>
  );

  const helper = (
    <p
      id={helperId}
      style={{
        margin: 0,
        fontFamily: 'var(--font-ui)',
        fontSize: 13,
        lineHeight: 1.4,
        color: 'var(--c-text-2)',
      }}
    >
      {value === OUTSIDE_US ? COPY.outsideLine : COPY.helper}
    </p>
  );

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--sp-1)',
        minWidth: 0,
        fontFamily: 'var(--font-ui)',
        ...(layout === 'banner' && !isMobile ? { flex: '0 1 auto' } : {}),
      }}
    >
      <label htmlFor={selectId} style={{ fontSize: 13, color: 'var(--c-text)' }}>
        {COPY.selectLabel}
      </label>
      <div
        style={{
          display: 'flex',
          flexDirection: isMobile ? 'column' : 'row',
          alignItems: isMobile ? 'stretch' : 'center',
          gap: 'var(--sp-2)',
        }}
      >
        <select
          id={selectId}
          value={value}
          aria-describedby={helperId}
          onChange={(e) => {
            setValue(e.target.value);
            setFailed(false);
          }}
          style={{
            minHeight: 44,
            boxSizing: 'border-box',
            minWidth: isMobile ? undefined : 220,
            maxWidth: '100%',
            padding: '0 var(--sp-3)',
            border: '1px solid var(--c-border)',
            borderRadius: 'var(--r-md)',
            background: 'var(--c-surface)',
            color: 'var(--c-text)',
            fontFamily: 'var(--font-ui)',
            fontSize: 14,
          }}
        >
          <option value="">{COPY.placeholder}</option>
          {US_STATES.map((s) => (
            <option key={s.code} value={s.code}>
              {s.name}
            </option>
          ))}
          <optgroup label={COPY.territories}>
            {US_TERRITORIES.map((t) => (
              <option key={t.code} value={t.code}>
                {t.name}
              </option>
            ))}
          </optgroup>
          <option value="__separator" disabled>
            {SEPARATOR}
          </option>
          <option value={OUTSIDE_US}>{COPY.outside}</option>
        </select>
        {isMobile && helper}
        {buttons}
      </div>
      {!isMobile && helper}
      {failed && (
        <p role="alert" style={{ margin: 0, fontSize: 13, color: 'var(--c-danger)' }}>
          {COPY.failed}
        </p>
      )}
    </div>
  );
}
