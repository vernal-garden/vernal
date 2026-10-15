import type { ReactNode } from 'react';

export interface ChipProps {
  children: ReactNode;
  /** A colour token for the background, e.g. 'var(--c-warning-bg)' (default --c-surface-raised). */
  background?: string;
  /** A colour token for the text (default --c-text). */
  color?: string;
}

// Small text label. Text and CSS only.
export default function Chip({ children, background = 'var(--c-surface-raised)', color = 'var(--c-text)' }: ChipProps) {
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '0 var(--sp-2)',
        borderRadius: 'var(--r-sm)',
        background,
        color,
        fontFamily: 'var(--font-ui)',
        fontSize: 12,
        fontWeight: 600,
        lineHeight: '20px',
        whiteSpace: 'nowrap',
        verticalAlign: 'middle',
      }}
    >
      {children}
    </span>
  );
}
