import { useEffect, useState } from 'react';
import { get } from '../lib/api';
import SubscriptionSettings from '../components/account/SubscriptionSettings';
import ProfileSettings from '../components/account/ProfileSettings';
import EmailSecuritySettings from '../components/account/EmailSecuritySettings';
import DataPrivacySettings from '../components/account/DataPrivacySettings';
import { secondaryButtonSt } from '../components/account/settingsStyles';
import { useSignOut } from '../hooks/useSignOut';
import type { AccountData } from '../components/account/types';

type Tab = 'profile' | 'email' | 'subscription' | 'privacy';

const TABS: { key: Tab; label: string }[] = [
  { key: 'profile', label: 'Profile' },
  { key: 'email', label: 'Email & Security' },
  { key: 'subscription', label: 'Subscription' },
  { key: 'privacy', label: 'Data & Privacy' },
];

function tabButtonSt(active: boolean): React.CSSProperties {
  return {
    padding: '10px 16px',
    border: 'none',
    borderRadius: 'var(--r-md)',
    background: active ? 'var(--c-primary-subtle)' : 'transparent',
    color: active ? 'var(--c-primary)' : 'var(--c-text-2)',
    fontFamily: 'var(--font-ui)',
    fontSize: 14,
    fontWeight: active ? 600 : 400,
    textAlign: 'left',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  };
}

export default function AccountPage() {
  const [account, setAccount] = useState<AccountData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [tab, setTab] = useState<Tab>('profile');
  const [signingOut, setSigningOut] = useState(false);
  const signOut = useSignOut();

  useEffect(() => {
    get<{ data: AccountData }>('/api/me')
      .then((res) => setAccount(res?.data ?? null))
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, []);

  function handleUpdate(patchData: Partial<AccountData>) {
    setAccount((prev) => (prev ? { ...prev, ...patchData } : prev));
  }

  async function handleSignOut() {
    setSigningOut(true);
    await signOut();
  }

  // Rendered twice (lg+ at the foot of the tab list, mobile below the content)
  // and toggled with Tailwind visibility classes so each layout gets one.
  function signOutButton(className: string) {
    return (
      <div className={className}>
        <button type="button" onClick={handleSignOut} disabled={signingOut} style={secondaryButtonSt}>
          {signingOut ? 'Signing out…' : 'Sign out'}
        </button>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: 'var(--sp-5)' }}>
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

      {loading && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--sp-9) 0' }}>
          <div
            style={{
              width: 32,
              height: 32,
              border: '2px solid var(--c-primary-light)',
              borderTopColor: 'var(--c-primary)',
              borderRadius: '50%',
              animation: 'spin 0.8s linear infinite',
            }}
          />
        </div>
      )}

      {!loading && error && (
        <p style={{ fontFamily: 'var(--font-ui)', fontSize: 14, color: 'var(--c-danger)' }}>
          Couldn't load your account.
        </p>
      )}

      {!loading && !error && account && (
        <div className="flex flex-col lg:flex-row gap-6">
          <div className="lg:w-56 shrink-0">
            <nav
              className="flex lg:flex-col gap-1 overflow-x-auto lg:overflow-visible"
              aria-label="Account settings sections"
            >
              {TABS.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setTab(t.key)}
                  style={tabButtonSt(tab === t.key)}
                >
                  {t.label}
                </button>
              ))}
            </nav>
            {signOutButton('hidden lg:block mt-6')}
          </div>

          <div style={{ flex: 1, minWidth: 0 }}>
            {tab === 'profile' && <ProfileSettings account={account} onUpdate={handleUpdate} />}
            {tab === 'email' && <EmailSecuritySettings account={account} onUpdate={handleUpdate} />}
            {tab === 'subscription' && <SubscriptionSettings />}
            {tab === 'privacy' && <DataPrivacySettings account={account} onUpdate={handleUpdate} />}
          </div>

          {signOutButton('lg:hidden')}
        </div>
      )}
    </div>
  );
}
