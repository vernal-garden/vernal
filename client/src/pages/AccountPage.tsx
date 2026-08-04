import SubscriptionSettings from '../components/account/SubscriptionSettings';

export default function AccountPage() {
  return (
    <div style={{ maxWidth: 680, margin: '0 auto', padding: 'var(--sp-5)' }}>
      <h1
        style={{
          margin: '0 0 var(--sp-5)',
          fontFamily: 'var(--font-display)',
          fontSize: 24,
          color: 'var(--c-text)',
        }}
      >
        Account
      </h1>
      <SubscriptionSettings />
    </div>
  );
}
