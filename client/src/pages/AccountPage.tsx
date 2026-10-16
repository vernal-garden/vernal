import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useIsMobile } from '../hooks/useIsMobile';
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

function isTab(value: string | null): value is Tab {
  return TABS.some((t) => t.key === value);
}

// Mobile: the section list row (48px) and the back control.
const mobileRowSt: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  width: '100%',
  minHeight: 48,
  boxSizing: 'border-box',
  padding: '0 var(--sp-4)',
  border: '1px solid var(--c-border-subtle)',
  borderRadius: 'var(--r-md)',
  background: 'var(--c-surface)',
  color: 'var(--c-text)',
  fontFamily: 'var(--font-ui)',
  fontSize: 15,
  textAlign: 'left',
  cursor: 'pointer',
};

const mobileBackSt: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 'var(--sp-1)',
  minHeight: 44,
  minWidth: 44,
  marginBottom: 'var(--sp-3)',
  padding: '0 var(--sp-3) 0 var(--sp-1)',
  border: 'none',
  background: 'transparent',
  color: 'var(--c-primary)',
  fontFamily: 'var(--font-ui)',
  fontSize: 14,
  fontWeight: 600,
  cursor: 'pointer',
};

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
  const isMobile = useIsMobile();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const sectionParam = searchParams.get('section');
  const [tab, setTab] = useState<Tab>(isTab(sectionParam) ? sectionParam : 'profile');
  // Mobile only: /account?section=<key> opens that section; no param shows the list.
  const mobileSection: Tab | null = isTab(sectionParam) ? sectionParam : null;

  // Keep the desktop tab in step if ?section changes (e.g. after crossing the breakpoint).
  useEffect(() => {
    if (isTab(sectionParam)) setTab(sectionParam);
  }, [sectionParam]);

  const backRef = useRef<HTMLButtonElement>(null);
  const rowRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});
  const prevSection = useRef<Tab | null>(mobileSection);

  // Move focus with the view change: Back when a section opens, the row just
  // closed when returning to the list. Skipped on first render (deep links).
  useEffect(() => {
    const prev = prevSection.current;
    prevSection.current = mobileSection;
    if (!isMobile || prev === mobileSection) return;
    if (mobileSection) backRef.current?.focus();
    else if (prev) rowRefs.current[prev]?.focus();
  }, [mobileSection, isMobile]);

  function openSection(key: Tab) {
    navigate({ search: `?section=${key}` }, { state: { fromList: true } });
  }

  function closeSection() {
    // Came from the list in this session: pop that entry. Deep link: replace.
    if ((location.state as { fromList?: boolean } | null)?.fromList) navigate(-1);
    else setSearchParams({}, { replace: true });
  }
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

  // Rendered twice (lg+ at the foot of the tab list, narrow desktop below the
  // content) and toggled with Tailwind visibility classes so each layout gets one.
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

      {!loading && !error && account && isMobile && (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {mobileSection ? (
            <>
              <div>
                <button ref={backRef} type="button" onClick={closeSection} style={mobileBackSt}>
                  <span aria-hidden="true">‹</span>
                  Back
                </button>
              </div>
              <h2
                style={{
                  margin: '0 0 var(--sp-3)',
                  fontFamily: 'var(--font-display)',
                  fontSize: 20,
                  color: 'var(--c-text)',
                }}
              >
                {TABS.find((t) => t.key === mobileSection)?.label}
              </h2>
              <div style={{ minWidth: 0 }}>
                {mobileSection === 'profile' && <ProfileSettings account={account} onUpdate={handleUpdate} />}
                {mobileSection === 'email' && <EmailSecuritySettings account={account} onUpdate={handleUpdate} />}
                {mobileSection === 'subscription' && <SubscriptionSettings />}
                {mobileSection === 'privacy' && <DataPrivacySettings account={account} onUpdate={handleUpdate} />}
              </div>
            </>
          ) : (
            <>
              <nav
                aria-label="Account settings sections"
                style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}
              >
                {TABS.map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    ref={(el) => { rowRefs.current[t.key] = el; }}
                    onClick={() => openSection(t.key)}
                    style={mobileRowSt}
                  >
                    {t.label}
                    <span aria-hidden="true" style={{ color: 'var(--c-text-3)' }}>›</span>
                  </button>
                ))}
              </nav>
              <div style={{ marginTop: 'var(--sp-5)' }}>
                <button type="button" onClick={handleSignOut} disabled={signingOut} style={secondaryButtonSt}>
                  {signingOut ? 'Signing out…' : 'Sign out'}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {!loading && !error && account && !isMobile && (
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

      {!loading && !error && account && (
        <Link
          to="/about"
          data-testid="account-help-about"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            minHeight: 44,
            marginTop: 'var(--sp-6)',
            padding: '0 var(--sp-4)',
            border: '1px solid var(--c-border-subtle)',
            borderRadius: 'var(--r-md)',
            background: 'var(--c-surface)',
            color: 'var(--c-text)',
            fontFamily: 'var(--font-ui)',
            fontSize: 14,
            textDecoration: 'none',
          }}
        >
          Help &amp; About
          <span aria-hidden="true" style={{ color: 'var(--c-text-3)' }}>›</span>
        </Link>
      )}
    </div>
  );
}
