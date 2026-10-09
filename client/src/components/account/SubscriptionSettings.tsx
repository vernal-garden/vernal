// client/src/components/account/SubscriptionSettings.tsx
import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { post, ApiError } from '../../lib/api';
import { useSubscription, type SubscriptionData } from '../../hooks/useSubscription';
import { PRICING, PRICING_ORDER, type Interval } from '../../config/pricing';

const SUPPORTER_FEATURES = [
  'Soil readings — track pH and nutrients per bed over time',
  'Amendment log — record fertilizer and amendment applications per bed',
  'Weather — local conditions plus your personal weather station',
  'Priority support and early access to new features',
];

const cardSt: React.CSSProperties = {
  border: '1px solid var(--c-border)',
  borderRadius: 'var(--r-lg)',
  background: 'var(--c-surface)',
  boxShadow: 'var(--shadow-sm)',
  padding: 'var(--sp-5)',
};

const cardTitleSt: React.CSSProperties = {
  margin: '0 0 var(--sp-2)',
  fontFamily: 'var(--font-display)',
  fontSize: 18,
  color: 'var(--c-text)',
};

const bodyTextSt: React.CSSProperties = {
  margin: 0,
  fontFamily: 'var(--font-ui)',
  fontSize: 14,
  color: 'var(--c-text-2)',
  lineHeight: 1.6,
};

const featureListSt: React.CSSProperties = {
  margin: 'var(--sp-3) 0 0',
  padding: 0,
  listStyle: 'none',
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--sp-2)',
};

const featureItemSt: React.CSSProperties = {
  ...bodyTextSt,
  display: 'flex',
  gap: 'var(--sp-2)',
};

const primaryButtonSt: React.CSSProperties = {
  padding: '10px 24px',
  fontSize: 14,
  fontFamily: 'var(--font-ui)',
  fontWeight: 600,
  border: 'none',
  borderRadius: 'var(--r-md)',
  background: 'var(--c-primary)',
  color: 'var(--c-text-on-primary)',
  cursor: 'pointer',
};

const secondaryButtonSt: React.CSSProperties = {
  padding: '10px 24px',
  fontSize: 14,
  fontFamily: 'var(--font-ui)',
  border: '1px solid var(--c-border)',
  borderRadius: 'var(--r-md)',
  background: 'transparent',
  color: 'var(--c-text-2)',
  cursor: 'pointer',
};

const linkButtonSt: React.CSSProperties = {
  padding: 0,
  border: 'none',
  background: 'none',
  fontFamily: 'var(--font-ui)',
  fontSize: 13,
  color: 'var(--c-primary)',
  textDecoration: 'underline',
  cursor: 'pointer',
};

const errorTextSt: React.CSSProperties = {
  margin: 'var(--sp-2) 0 0',
  fontFamily: 'var(--font-ui)',
  fontSize: 13,
  color: 'var(--c-danger)',
};

function intervalOptionSt(active: boolean, distinct: boolean): React.CSSProperties {
  return {
    flex: 1,
    padding: 'var(--sp-3)',
    border: `1px solid ${active ? 'var(--c-primary)' : 'var(--c-border)'}`,
    borderRadius: 'var(--r-md)',
    background: active ? 'var(--c-primary-subtle)' : distinct ? 'var(--c-secondary-light)' : 'transparent',
    cursor: 'pointer',
    textAlign: 'left',
    fontFamily: 'var(--font-ui)',
  };
}

function formatDate(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

// ── Interval selector ──────────────────────────────────────────────────────────

function IntervalSelector({
  selected,
  onSelect,
}: {
  selected: Interval;
  onSelect: (i: Interval) => void;
}) {
  return (
    <div style={{ display: 'flex', gap: 'var(--sp-2)', margin: 'var(--sp-3) 0' }}>
      {PRICING_ORDER.map((key) => {
        const opt = PRICING[key];
        const active = selected === key;
        return (
          <button
            key={key}
            type="button"
            onClick={() => onSelect(key)}
            style={intervalOptionSt(active, key === 'lifetime')}
          >
            {opt.badge && (
              <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--c-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>
                {opt.badge}
              </div>
            )}
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--c-text)' }}>{opt.label}</div>
            <div style={{ fontSize: 13, color: 'var(--c-text-2)' }}>{opt.priceLabel}</div>
            {opt.subLabel && (
              <div style={{ fontSize: 11, color: 'var(--c-text-3)', marginTop: 2 }}>{opt.subLabel}</div>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ── Free tier ─────────────────────────────────────────────────────────────────

function FreeView() {
  const [revealed, setRevealed] = useState(false);
  const [interval, setInterval_] = useState<Interval>('annual');
  const [whyOpen, setWhyOpen] = useState(false);
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);

  async function handleBecomeSupporter() {
    if (!revealed) {
      setRevealed(true);
      return;
    }
    setCheckoutLoading(true);
    setCheckoutError(null);
    try {
      const res = await post<{ url: string }>('/api/subscription/checkout', { interval });
      if (!res?.url) throw new Error('No checkout URL returned');
      window.location.href = res.url;
    } catch {
      setCheckoutError("Couldn't start checkout. Please try again.");
      setCheckoutLoading(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)' }}>
      <div style={cardSt}>
        <h3 style={cardTitleSt}>Vernal Free</h3>
        <p style={bodyTextSt}>
          Unlimited gardens and beds, the seed catalogue, and planting guidance — free, forever.
        </p>
      </div>

      <div style={cardSt}>
        <h3 style={cardTitleSt}>Vernal Supporter</h3>
        <ul style={featureListSt}>
          {SUPPORTER_FEATURES.map((f) => (
            <li key={f} style={featureItemSt}>
              <span style={{ color: 'var(--c-primary)' }}>✓</span>
              <span>{f}</span>
            </li>
          ))}
        </ul>

        {revealed && <IntervalSelector selected={interval} onSelect={setInterval_} />}

        <div style={{ marginTop: 'var(--sp-4)', display: 'flex', alignItems: 'center', gap: 'var(--sp-4)' }}>
          <button
            type="button"
            onClick={handleBecomeSupporter}
            disabled={checkoutLoading}
            style={primaryButtonSt}
          >
            {checkoutLoading ? 'Redirecting…' : 'Become a Supporter'}
          </button>
          <button type="button" onClick={() => setWhyOpen((v) => !v)} style={linkButtonSt}>
            Why support Vernal?
          </button>
        </div>

        {checkoutError && <p style={errorTextSt}>{checkoutError}</p>}

        {whyOpen && (
          <div
            style={{
              marginTop: 'var(--sp-4)',
              padding: 'var(--sp-4)',
              background: 'var(--c-surface-inset)',
              borderRadius: 'var(--r-md)',
            }}
          >
            <p style={bodyTextSt}>
              Vernal is open-core. Garden planning, the seed catalogue, and planting guidance stay free for
              everyone, always. Supporter subscriptions fund hosting and ongoing development, including
              features like weather integration and soil tracking. No ads, and we never sell your data.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Supporter tier ────────────────────────────────────────────────────────────

function SupporterView({ data }: { data: SubscriptionData }) {
  const [portalLoading, setPortalLoading] = useState(false);
  const [portalError, setPortalError] = useState<string | null>(null);

  const isLifetime = data.interval === 'lifetime';
  const intervalLabel = data.interval ? PRICING[data.interval].label : 'Supporter';

  async function handleManageBilling() {
    setPortalLoading(true);
    setPortalError(null);
    try {
      const res = await post<{ url: string }>('/api/subscription/portal');
      if (!res?.url) throw new Error('No portal URL returned');
      window.location.href = res.url;
    } catch (e) {
      const message =
        e instanceof ApiError && e.status === 400
          ? 'No billing account found. Please subscribe first.'
          : "Couldn't open billing. Please try again.";
      setPortalError(message);
      setPortalLoading(false);
    }
  }

  return (
    <div style={cardSt}>
      <h3 style={cardTitleSt}>Vernal Supporter</h3>
      <p style={{ ...bodyTextSt, fontWeight: 600, color: 'var(--c-text)' }}>{intervalLabel}</p>

      {isLifetime ? (
        <p style={bodyTextSt}>Lifetime access.</p>
      ) : (
        <p style={bodyTextSt}>
          {data.cancelledAt
            ? `Active until ${formatDate(data.periodEnd)}. Your subscription won't renew.`
            : `Next billing date: ${formatDate(data.periodEnd)}`}
        </p>
      )}

      <div style={{ marginTop: 'var(--sp-4)' }}>
        <button type="button" onClick={handleManageBilling} disabled={portalLoading} style={secondaryButtonSt}>
          {portalLoading ? 'Redirecting…' : isLifetime ? 'View payment history' : 'Manage billing'}
        </button>
      </div>

      {portalError && <p style={errorTextSt}>{portalError}</p>}
    </div>
  );
}

// ── Root ──────────────────────────────────────────────────────────────────────

export default function SubscriptionSettings() {
  const { data, loading, error, reload } = useSubscription();
  const [searchParams] = useSearchParams();
  const subscribed = searchParams.get('subscribed') === 'true';

  useEffect(() => {
    if (!subscribed) return;
    reload();
    const t = setTimeout(reload, 2000);
    return () => clearTimeout(t);
  }, [subscribed, reload]);

  return (
    <section>
      <h2
        style={{
          margin: '0 0 var(--sp-4)',
          fontFamily: 'var(--font-display)',
          fontSize: 20,
          color: 'var(--c-text)',
        }}
      >
        Subscription
      </h2>

      {subscribed && data && (
        <div
          style={{
            marginBottom: 'var(--sp-4)',
            padding: 'var(--sp-3) var(--sp-4)',
            background: data.isSupporter ? 'var(--c-success-bg)' : 'var(--c-info-bg)',
            color: data.isSupporter ? 'var(--c-success)' : 'var(--c-info)',
            borderRadius: 'var(--r-md)',
            fontFamily: 'var(--font-ui)',
            fontSize: 14,
          }}
        >
          {data.isSupporter
            ? 'Welcome to Vernal Supporter. Thanks for supporting the project.'
            : 'Changes may take a moment to reflect.'}
        </div>
      )}

      {loading && <p style={bodyTextSt}>Loading…</p>}

      {!loading && error && (
        <div>
          <p style={errorTextSt}>Couldn't load your subscription.</p>
          <button type="button" onClick={reload} style={secondaryButtonSt}>
            Retry
          </button>
        </div>
      )}

      {!loading && !error && data && (data.isSupporter ? <SupporterView data={data} /> : <FreeView />)}
    </section>
  );
}
