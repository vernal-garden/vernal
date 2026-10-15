import type React from 'react';
import { Link } from 'react-router-dom';
import { FEATURE_GATES } from '../lib/featureGates';

// The Supporter gate as a slim banner above read-only data: a free account
// viewing (and deleting) records it created as a Supporter.

interface Props {
  gateKey: string;
  style?: React.CSSProperties;
}

const linkStyle: React.CSSProperties = {
  minHeight: 44,
  padding: '0 var(--sp-4)',
  display: 'inline-flex',
  alignItems: 'center',
  flexShrink: 0,
  fontSize: 14,
  fontWeight: 600,
  borderRadius: 'var(--r-md)',
  background: 'var(--c-primary)',
  color: 'var(--c-text-on-primary)',
  textDecoration: 'none',
};

export default function UpgradeBanner({ gateKey, style }: Props) {
  const gate = FEATURE_GATES[gateKey];
  return (
    <section
      aria-label={gate?.featureName ?? 'Premium feature'}
      style={{
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 'var(--sp-3)',
        padding: 'var(--sp-3) var(--sp-4)',
        marginBottom: 'var(--sp-4)',
        background: 'var(--c-primary-subtle)',
        borderRadius: 'var(--r-md)',
        fontFamily: 'var(--font-ui)',
        ...style,
      }}
    >
      <div style={{ flex: 1, minWidth: 200 }}>
        <p style={{ margin: 0, fontSize: 14, color: 'var(--c-text-2)', lineHeight: 1.5 }}>
          {gate?.description ?? 'This feature is available to Supporter accounts.'}
        </p>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--c-text-3)' }}>
          Upgrade to <strong style={{ color: 'var(--c-primary)' }}>Supporter</strong> to add or edit entries.
        </p>
      </div>
      <Link to="/account" style={linkStyle}>
        Learn more &amp; upgrade
      </Link>
    </section>
  );
}
