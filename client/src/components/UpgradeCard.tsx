import type React from 'react';
import { Link } from 'react-router-dom';
import { FEATURE_GATES } from '../lib/featureGates';

// The inline Supporter gate: UpgradePrompt's content at card size, for a slot
// inside a page (the Metrics Dashboard's paid section) rather than a whole page.

interface Props {
  gateKey: string;
  style?: React.CSSProperties;
}

const buttonStyle: React.CSSProperties = {
  minHeight: 44,
  minWidth: 44,
  padding: '0 var(--sp-4)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  alignSelf: 'flex-start',
  fontSize: 14,
  fontFamily: 'var(--font-ui)',
  fontWeight: 600,
  border: 'none',
  borderRadius: 'var(--r-md)',
  background: 'var(--c-primary)',
  color: 'var(--c-text-on-primary)',
  textDecoration: 'none',
  cursor: 'pointer',
};

export default function UpgradeCard({ gateKey, style }: Props) {
  const gate = FEATURE_GATES[gateKey];
  return (
    <section
      aria-label={gate?.featureName ?? 'Premium feature'}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--sp-3)',
        padding: 'var(--sp-5)',
        background: 'var(--c-surface)',
        border: '1px solid var(--c-border-subtle)',
        borderRadius: 'var(--r-lg)',
        boxShadow: 'var(--shadow-sm)',
        fontFamily: 'var(--font-ui)',
        boxSizing: 'border-box',
        ...style,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-3)' }}>
        <span
          aria-hidden="true"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            width: 40,
            height: 40,
            borderRadius: 'var(--r-full)',
            background: 'var(--c-primary-subtle)',
            fontSize: 18,
          }}
        >
          🌱
        </span>
        <h2 style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 600, color: 'var(--c-text)' }}>
          {gate?.featureName ?? 'Premium feature'}
        </h2>
      </div>
      <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, color: 'var(--c-text-2)' }}>
        {gate?.description ?? 'This feature is available to Supporter accounts.'}
      </p>
      <p style={{ margin: 0, fontSize: 13, color: 'var(--c-text-3)' }}>
        {/* ED: replace with final copy */}
        Available with <strong style={{ color: 'var(--c-primary)' }}>Supporter</strong>.
      </p>
      <Link to="/account" style={buttonStyle}>
        Learn more &amp; upgrade
      </Link>
    </section>
  );
}
