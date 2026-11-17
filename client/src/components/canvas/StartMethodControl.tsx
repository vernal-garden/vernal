import { useRef } from 'react';
import type { KeyboardEvent } from 'react';
import type { StartMethod } from '../../hooks/usePlantings';

// Phase 70: "How it goes in", shared by the placement popover and the
// inspection popover's Change form. A radio group: one tab stop, arrow keys
// move and select, as native radios do.

const OPTIONS: { value: StartMethod; label: string }[] = [
  { value: 'sown', label: 'Sowing seed here' },
  { value: 'transplanted', label: 'Transplanting a start' },
];

interface Props {
  value: StartMethod;
  onChange: (value: StartMethod) => void;
  disabled?: boolean;
}

export default function StartMethodControl({ value, onChange, disabled = false }: Props) {
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1
      : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1
        : 0;
    if (step === 0 || disabled) return;
    e.preventDefault();
    const current = OPTIONS.findIndex(o => o.value === value);
    const next = (current + step + OPTIONS.length) % OPTIONS.length;
    onChange(OPTIONS[next].value);
    buttonRefs.current[next]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label="How it goes in"
      onKeyDown={onKeyDown}
      style={{
        display: 'flex', gap: 2, padding: 2,
        border: '1px solid var(--c-border)', borderRadius: 'var(--r-md)', background: 'var(--c-surface-raised)',
      }}
    >
      {OPTIONS.map((option, i) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            ref={el => { buttonRefs.current[i] = el; }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            style={{
              flex: 1, minWidth: 0, minHeight: 44, padding: '0 var(--sp-1)',
              border: `1px solid ${selected ? 'var(--c-text-2)' : 'transparent'}`,
              borderRadius: 'var(--r-sm)',
              background: selected ? 'var(--c-surface)' : 'transparent',
              color: selected ? 'var(--c-text)' : 'var(--c-text-2)',
              fontSize: 12, fontWeight: selected ? 600 : 400, lineHeight: 1.25, fontFamily: 'inherit',
              cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.6 : 1,
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
