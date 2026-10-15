import type { CSSProperties, ReactNode } from 'react';
import { Link } from 'react-router-dom';

export interface StatCardProps {
  label: string;
  value: ReactNode;
  sublabel?: ReactNode;
  tone?: 'attention';
  /** When set, the whole card links here. */
  to?: string;
}

export default function StatCard({ label, value, sublabel, tone, to }: StatCardProps) {
  const style: CSSProperties = {
    display: 'block',
    padding: 'var(--sp-3) var(--sp-4)',
    background: tone === 'attention' ? 'var(--c-warning-bg)' : 'var(--c-surface)',
    border: '1px solid var(--c-border)',
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

  return to ? (
    <Link to={to} style={style}>
      {body}
    </Link>
  ) : (
    <div style={style}>{body}</div>
  );
}
