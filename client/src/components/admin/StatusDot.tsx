import type { CSSProperties } from 'react';

export type StatusDotKind = 'filled' | 'half' | 'empty' | 'check';

export interface StatusDotProps {
  kind: StatusDotKind;
  label: string;
  /** Colour token for the dot (default --c-primary). */
  color?: string;
}

// A small CSS circle (filled / half / outlined) or a check glyph. Not an icon.
export default function StatusDot({ kind, label, color = 'var(--c-primary)' }: StatusDotProps) {
  if (kind === 'check') {
    return (
      <span role="img" aria-label={label} title={label} style={{ color, fontSize: 14, lineHeight: 1 }}>
        ✓
      </span>
    );
  }

  const style: CSSProperties = {
    display: 'inline-block',
    width: 10,
    height: 10,
    boxSizing: 'border-box',
    borderRadius: 'var(--r-full)',
    border: `1.5px solid ${color}`,
    verticalAlign: 'middle',
    background:
      kind === 'filled' ? color : kind === 'half' ? `linear-gradient(90deg, ${color} 50%, transparent 50%)` : 'transparent',
  };

  return <span role="img" aria-label={label} title={label} style={style} />;
}
