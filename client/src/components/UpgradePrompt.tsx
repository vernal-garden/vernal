import { FEATURE_GATES } from '../lib/featureGates';

interface Props {
  gateKey: string;
}

export default function UpgradePrompt({ gateKey }: Props) {
  const gate = FEATURE_GATES[gateKey];
  return (
    <div style={{
      maxWidth: 480, margin: '0 auto',
      padding: 'var(--sp-7) var(--sp-5)',
      textAlign: 'center',
    }}>
      <div style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 56, height: 56, borderRadius: 'var(--r-full)',
        background: 'var(--c-primary-subtle)', marginBottom: 'var(--sp-4)',
      }}>
        <span style={{ fontSize: 24 }}>🌱</span>
      </div>
      <h2 style={{
        margin: '0 0 var(--sp-2)',
        fontFamily: 'var(--font-display)', fontSize: 22, color: 'var(--c-text)',
      }}>
        {gate?.featureName ?? 'Premium feature'}
      </h2>
      <p style={{
        margin: '0 0 var(--sp-5)',
        fontFamily: 'var(--font-ui)', fontSize: 15, color: 'var(--c-text-2)',
        lineHeight: 1.6,
      }}>
        {gate?.description ?? 'This feature is available to Supporter accounts.'}
      </p>
      <p style={{
        fontFamily: 'var(--font-ui)', fontSize: 14, color: 'var(--c-text-3)',
      }}>
        Upgrade to <strong style={{ color: 'var(--c-primary)' }}>Supporter</strong> to unlock this feature.
      </p>
    </div>
  );
}
