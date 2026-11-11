import type { CSSProperties, ReactNode } from 'react';
import { Link } from 'react-router-dom';

export interface StatCardProps {
  label: string;
  value: ReactNode;
  sublabel?: ReactNode;
  tone?: 'attention';
  /** When set, the whole card links here. */
  to?: string;
  /** When set, the whole card is a toggle button. */
  onClick?: () => void;
  pressed?: boolean;
}

export default function StatCard({ label, value, sublabel, tone, to, onClick, pressed }: StatCardProps) {
  const style: CSSProperties = {
    display: 'block',
    padding: 'var(--sp-3) var(--sp-4)',
    background: tone === 'attention' ? 'var(--c-warning-bg)' : 'var(--c-surface)',
    // Same width either way, so pressing a card shifts nothing.
    border: `1px solid ${onClick && pressed ? 'var(--c-primary)' : 'var(--c-border)'}`,
    borderRadius: 'var(--r-md)',
    color: 'var(--c-text)',
    textDecoration: 'none',
    fontFamily: 'var(--font-ui)',
    minWidth: 0,
  };

  const body = (
    <>
      <div style={{ fontSize: 12, color: 'var(--c-text-2)', lineHeight: '16px' }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 600, lineHeight: '30px', marginTop: 'var(--sp-1)', fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </div>
      {sublabel != null && <div style={{ fontSize: 12, color: 'var(--c-text-3)', lineHeight: '16px' }}>{sublabel}</div>}
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        aria-pressed={pressed}
        onClick={onClick}
        // font first, so the card's own fontFamily still applies over the button default.
        style={{ font: 'inherit', ...style, textAlign: 'left', width: '100%', cursor: 'pointer' }}
      >
        {body}
      </button>
    );
  }

  return to ? (
    <Link to={to} style={style}>
      {body}
    </Link>
  ) : (
    <div style={style}>{body}</div>
  );
}
