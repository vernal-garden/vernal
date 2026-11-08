import type { MouseEvent } from 'react';

interface Props {
  checked: boolean;
  onClick: (e: MouseEvent<HTMLButtonElement>) => void;
  labelledBy: string;
  describedBy?: string;
  /** A change is in flight. Stays focusable; the caller ignores clicks meanwhile. */
  busy?: boolean;
  /** Adds a 1px track border, so the off state clears 3:1 against the surface. */
  outlined?: boolean;
}

// 40x24 track and 18px thumb in a 44x44 hit area.
export default function Switch({ checked, onClick, labelledBy, describedBy, busy, outlined }: Props) {
  // The thumb sits inside the border, so its offsets shrink by the border's width.
  const inset = outlined ? 2 : 3;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      aria-disabled={busy || undefined}
      onClick={onClick}
      style={{
        flexShrink: 0, minWidth: 44, minHeight: 44, padding: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'none', border: 'none', cursor: busy ? 'not-allowed' : 'pointer',
        opacity: busy ? 0.55 : 1,
      }}
    >
      <span style={{
        position: 'relative', width: 40, height: 24, borderRadius: 'var(--r-full)',
        boxSizing: 'border-box',
        background: checked ? 'var(--c-primary)' : 'var(--c-border)',
        border: outlined ? `1px solid ${checked ? 'var(--c-primary)' : 'var(--c-text-3)'}` : undefined,
        transition: outlined ? 'background 0.15s, border-color 0.15s' : 'background 0.15s',
      }}>
        <span style={{
          position: 'absolute', top: inset, left: checked ? inset + 16 : inset,
          width: 18, height: 18, borderRadius: 'var(--r-full)',
          background: 'var(--c-surface)', boxShadow: 'var(--shadow-sm)',
          transition: 'left 0.15s',
        }} />
      </span>
    </button>
  );
}
