import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import {
  adminApi,
  apiErrorMessage,
  type AccountDetail,
  type AccountRole,
  type AccountRow,
  type SubscriptionTier,
  type UsersChartRange,
  type UsersCharts,
  type UsersSummary,
} from '../../lib/adminApi';
import { ApiError, get } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import Button from '../../components/admin/Button';
import ConfirmDialog from '../../components/admin/ConfirmDialog';
import DataTable, { type DataTableColumn } from '../../components/admin/DataTable';
import Pager from '../../components/admin/Pager';
import StatCard from '../../components/admin/StatCard';
import { EMPTY, formatDate, formatNumber, formatPercent } from '../../components/admin/format';

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 300;

const RANGES: Array<{ value: UsersChartRange; label: string }> = [
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
  { value: 'all', label: 'All time' },
];

const TIER_SERIES: Array<{ key: 'free' | 'paid' | 'lifetime' | 'comped'; label: string; color: string }> = [
  { key: 'free', label: 'Free', color: 'var(--c-text-3)' },
  { key: 'paid', label: 'Paid', color: 'var(--c-primary)' },
  { key: 'lifetime', label: 'Lifetime', color: 'var(--c-secondary)' },
  { key: 'comped', label: 'Comped', color: 'var(--c-warning)' },
];

const controlStyle: CSSProperties = {
  height: 36,
  boxSizing: 'border-box',
  padding: '0 var(--sp-2)',
  border: '1px solid var(--c-border)',
  borderRadius: 'var(--r-md)',
  background: 'var(--c-surface)',
  color: 'var(--c-text)',
  fontFamily: 'var(--font-ui)',
  fontSize: 14,
};

const labelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--sp-1)',
  fontSize: 12,
  color: 'var(--c-text-2)',
};

const panelStyle: CSSProperties = {
  background: 'var(--c-surface)',
  border: '1px solid var(--c-border)',
  borderRadius: 'var(--r-md)',
};

const sectionHeading: CSSProperties = { margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--c-text)' };

const axisTick = { fontFamily: 'var(--font-ui)', fontSize: 11, fill: 'var(--c-text-3)' };

const tooltipStyle: CSSProperties = {
  fontFamily: 'var(--font-ui)',
  fontSize: 12,
  background: 'var(--c-surface)',
  border: '1px solid var(--c-border)',
  borderRadius: 'var(--r-md)',
};

function shortDate(value: string): string {
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function monthLabel(value: string): string {
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

function tierLabel(row: Pick<AccountRow, 'subscription_tier' | 'subscription_interval'>): string {
  return row.subscription_interval ? `${row.subscription_tier} (${row.subscription_interval})` : row.subscription_tier;
}

// Setting a Stripe subscriber to free leaves the subscription billing, and the
// next Stripe event puts them back on supporter, so the UI doesn't offer it.
function hasPaidSubscription(row: AccountRow | AccountDetail): boolean {
  if (row.subscription_tier !== 'supporter') return false;
  if (row.subscription_interval === 'monthly' || row.subscription_interval === 'annual') return true;
  return 'stripe_subscription_id' in row && row.stripe_subscription_id !== null;
}

type PendingAction =
  | { kind: 'tier'; id: number; email: string; next: SubscriptionTier }
  | { kind: 'role'; id: number; email: string; next: AccountRole };

function tierAction(row: AccountRow): PendingAction {
  return {
    kind: 'tier',
    id: row.id,
    email: row.email,
    next: row.subscription_tier === 'free' ? 'supporter' : 'free',
  };
}

function roleAction(row: AccountRow): PendingAction {
  return { kind: 'role', id: row.id, email: row.email, next: row.role === 'user' ? 'admin' : 'user' };
}

function actionLabel(a: PendingAction): string {
  if (a.kind === 'tier') return a.next === 'supporter' ? 'Comp as Supporter' : 'Set to free';
  return a.next === 'admin' ? 'Make admin' : 'Remove admin';
}

function actionTitle(a: PendingAction): string {
  if (a.kind === 'tier') return a.next === 'supporter' ? `Comp ${a.email} as Supporter?` : `Set ${a.email} to free?`;
  return a.next === 'admin' ? `Make ${a.email} an admin?` : `Remove admin from ${a.email}?`;
}

function actionMessage(a: PendingAction): string {
  if (a.kind === 'tier') {
    return a.next === 'supporter'
      ? `${a.email} will get the Supporter tier without a payment. A Stripe event overwrites a comped tier.`
      : `${a.email} will be moved to the free tier.`;
  }
  return a.next === 'admin'
    ? `${a.email} will be able to use the admin dashboard and change other accounts.`
    : `${a.email} will lose access to the admin dashboard.`;
}

interface ListResult {
  data: AccountRow[];
  /** Only set for paged (non-search) results. */
  total: number | null;
}

export default function UsersPage() {
  const { account } = useAuth();
  const myId = account?.id ?? null; // string in AuthContext

  // ── Summary ──
  const [summary, setSummary] = useState<UsersSummary | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  // Bumped after a tier/role change so totals and charts are re-fetched.
  const [refreshKey, setRefreshKey] = useState(0);
  const summaryReq = useRef(0);

  useEffect(() => {
    const id = ++summaryReq.current;
    adminApi
      .usersSummary()
      .then((res) => {
        if (id !== summaryReq.current) return;
        setSummary(res);
        setSummaryError(null);
      })
      .catch((err: unknown) => {
        if (id !== summaryReq.current) return;
        setSummaryError(apiErrorMessage(err, 'Could not load user totals.'));
      });
  }, [refreshKey]);

  // ── Charts ──
  const [range, setRange] = useState<UsersChartRange>('30d');
  const [charts, setCharts] = useState<UsersCharts | null>(null);
  const [chartsLoading, setChartsLoading] = useState(true);
  const [chartsError, setChartsError] = useState<string | null>(null);
  const chartsReq = useRef(0);

  useEffect(() => {
    const id = ++chartsReq.current;
    setChartsLoading(true);
    setChartsError(null);
    adminApi
      .usersCharts(range)
      .then((res) => {
        if (id !== chartsReq.current) return;
        setCharts(res);
        setChartsLoading(false);
      })
      .catch((err: unknown) => {
        if (id !== chartsReq.current) return;
        setCharts(null);
        setChartsError(apiErrorMessage(err, 'Could not load charts.'));
        setChartsLoading(false);
      });
  }, [range, refreshKey]);

  // ── Accounts list ──
  const [emailInput, setEmailInput] = useState('');
  const [email, setEmail] = useState('');
  const [page, setPage] = useState(1);
  const [list, setList] = useState<ListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const listReq = useRef(0);

  useEffect(() => {
    const trimmed = emailInput.trim();
    if (trimmed === email) return;
    const t = window.setTimeout(() => {
      setEmail(trimmed);
      setPage(1);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [emailInput, email]);

  useEffect(() => {
    const id = ++listReq.current;
    setLoading(true);
    setError(null);
    const request: Promise<ListResult> = email
      ? adminApi.searchAccounts(email).then((r) => ({ data: r.data, total: null }))
      : adminApi.accounts(page).then((r) => ({ data: r.data, total: r.total }));
    request
      .then((res) => {
        if (id !== listReq.current) return;
        setList(res);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (id !== listReq.current) return;
        setError(apiErrorMessage(err, 'Could not load accounts.'));
        setLoading(false);
      });
  }, [email, page]);

  // ── Detail panel ──
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<AccountDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const detailReq = useRef(0);
  const closeRef = useRef<HTMLButtonElement>(null);
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  // Element focused when the panel opened (normally the clicked row), refocused on close.
  const openerRef = useRef<HTMLElement | null>(null);

  const loadDetail = useCallback((accountId: number, quiet: boolean) => {
    const id = ++detailReq.current;
    if (!quiet) {
      setDetail(null);
      setDetailError(null);
      setDetailLoading(true);
    }
    adminApi
      .account(accountId)
      .then((res) => {
        if (id !== detailReq.current) return;
        setDetail(res);
        setDetailError(null);
        setDetailLoading(false);
      })
      .catch((err: unknown) => {
        if (id !== detailReq.current) return;
        setDetailError(
          err instanceof ApiError && err.status === 404
            ? 'Account not found.'
            : apiErrorMessage(err, 'Could not load account.'),
        );
        setDetailLoading(false);
      });
  }, []);

  useEffect(() => {
    if (selectedId === null) {
      ++detailReq.current;
      setDetail(null);
      setDetailError(null);
      setDetailLoading(false);
      return;
    }
    loadDetail(selectedId, false);
  }, [selectedId, loadDetail]);

  useEffect(() => {
    if (selectedId !== null) closeRef.current?.focus();
  }, [selectedId]);

  // ── Tier / role actions ──
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  // Role changes need the admin's password. AuthContext's account doesn't carry
  // isPasswordAccount, so read it from /api/me; default true so the field shows
  // until we know.
  const [isPasswordAccount, setIsPasswordAccount] = useState(true);
  const [rolePassword, setRolePassword] = useState('');
  const [reauthRequired, setReauthRequired] = useState(false);
  const [passwordHint, setPasswordHint] = useState(false);

  useEffect(() => {
    let cancelled = false;
    get<{ data: { isPasswordAccount: boolean } }>('/api/me')
      .then((res) => {
        if (!cancelled && res) setIsPasswordAccount(res.data.isPasswordAccount);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (pending === null) {
      setRolePassword('');
      setReauthRequired(false);
      setPasswordHint(false);
    }
  }, [pending]);

  const openPanel = useCallback((accountId: number) => {
    if (selectedRef.current === null) {
      const active = document.activeElement;
      openerRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
    }
    setSelectedId(accountId);
  }, []);

  const closePanel = useCallback(() => {
    setSelectedId(null);
    const opener = openerRef.current;
    openerRef.current = null;
    if (opener && opener.isConnected) opener.focus();
  }, []);

  // Escape closes the panel, but not while a confirm dialog is open (it handles its own Escape).
  useEffect(() => {
    if (selectedId === null) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape' || e.defaultPrevented || pendingRef.current) return;
      const target = e.target as HTMLElement | null;
      if (target && target.closest?.('input, textarea, select')) return;
      closePanel();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId, closePanel]);

  function openAction(a: PendingAction) {
    setActionError(null);
    setRolePassword('');
    setReauthRequired(false);
    setPasswordHint(false);
    setPending(a);
  }

  async function confirmAction() {
    if (!pending) return;
    const needsPassword = pending.kind === 'role' && isPasswordAccount;
    if (needsPassword && rolePassword === '') {
      setPasswordHint(true);
      return;
    }
    setBusy(true);
    setActionError(null);
    setReauthRequired(false);
    try {
      if (pending.kind === 'tier') {
        const res = await adminApi.setTier(pending.id, pending.next);
        const patchRow = <T extends AccountRow>(r: T): T =>
          r.id === res.id ? { ...r, subscription_tier: res.subscriptionTier } : r;
        setList((prev) => (prev ? { ...prev, data: prev.data.map(patchRow) } : prev));
        setDetail((prev) => (prev ? patchRow(prev) : prev));
      } else {
        const res = await adminApi.setRole(pending.id, pending.next, needsPassword ? rolePassword : undefined);
        const patchRow = <T extends AccountRow>(r: T): T => (r.id === res.id ? { ...r, role: res.role } : r);
        setList((prev) => (prev ? { ...prev, data: prev.data.map(patchRow) } : prev));
        setDetail((prev) => (prev ? patchRow(prev) : prev));
      }
      // Re-fetch the open account (fresh "Updated") and the totals/charts the change affects.
      if (selectedRef.current === pending.id) loadDetail(pending.id, true);
      setRefreshKey((k) => k + 1);
      setPending(null);
    } catch (err: unknown) {
      const body = err instanceof ApiError ? (err.body as { code?: unknown } | null) : null;
      if (body && body.code === 'reauth_required') {
        setReauthRequired(true);
        setActionError(null);
      } else {
        setActionError(apiErrorMessage(err, 'Could not update this account.'));
      }
    } finally {
      setBusy(false);
    }
  }

  function isSelf(row: AccountRow): boolean {
    return myId !== null && String(row.id) === String(myId);
  }

  function actionButtons(row: AccountRow, size: 'row' | 'panel'): ReactNode {
    const self = isSelf(row);
    const style = size === 'row' ? { height: 28 } : undefined;
    return (
      <span style={{ display: 'inline-flex', gap: 'var(--sp-2)' }}>
        {hasPaidSubscription(row) ? (
          <span style={{ alignSelf: 'center', color: 'var(--c-text-2)' }}>
            {size === 'row' ? 'Paid via Stripe' : 'Paid subscription. Cancel it in Stripe to downgrade.'}
          </span>
        ) : (
          <Button variant="secondary" style={style} onClick={() => openAction(tierAction(row))}>
            {actionLabel(tierAction(row))}
          </Button>
        )}
        <Button
          variant="secondary"
          style={style}
          disabled={self}
          title={self ? 'You cannot change your own role.' : undefined}
          onClick={() => openAction(roleAction(row))}
        >
          {actionLabel(roleAction(row))}
        </Button>
      </span>
    );
  }

  const columns: Array<DataTableColumn<AccountRow>> = [
    { key: 'email', header: 'Email', render: (r) => r.email },
    { key: 'name', header: 'Name', render: (r) => r.display_name ?? EMPTY },
    { key: 'created_at', header: 'Signed up', width: 130, render: (r) => formatDate(r.created_at) },
    { key: 'last_active_at', header: 'Last active', width: 130, render: (r) => formatDate(r.last_active_at) },
    { key: 'tier', header: 'Tier', width: 170, render: (r) => tierLabel(r) },
    { key: 'role', header: 'Role', width: 80, render: (r) => r.role },
    { key: 'actions', header: 'Actions', width: 330, render: (r) => actionButtons(r, 'row') },
  ];

  const stat = (value: number | undefined) => (summary && value !== undefined ? formatNumber(value) : EMPTY);

  return (
    <div style={{ padding: 'var(--sp-5)', display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, minmax(0, 1fr))', gap: 'var(--sp-3)' }}>
        <StatCard label="Total users" value={stat(summary?.totalUsers)} />
        <StatCard label="Active (30 days)" value={stat(summary?.active30d)} />
        <StatCard label="Free (active)" value={stat(summary?.freeActive30d)} />
        <StatCard label="Paid subscribers" value={stat(summary?.paidSubscribers)} />
        <StatCard label="Lifetime" value={stat(summary?.lifetime)} />
        <StatCard label="Supporters" value={stat(summary?.supporters)} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 'var(--sp-3)' }}>
        <StatCard label="New signups (7 days)" value={stat(summary?.newSignups7d)} />
        <StatCard label="New signups (30 days)" value={stat(summary?.newSignups30d)} />
        <StatCard label="Churned (30 days)" value={stat(summary?.churned30d)} />
        <StatCard
          label="Upgrade rate (signups, last 30 days)"
          value={summary ? formatPercent(summary.upgradeRate30d) : EMPTY}
        />
      </div>
      {summaryError && (
        <p role="alert" style={{ margin: 0, color: 'var(--c-danger)' }}>
          {summaryError}
        </p>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-3)' }}>
        <span id="users-range-label" style={{ fontSize: 12, color: 'var(--c-text-2)' }}>
          Range
        </span>
        <div role="group" aria-labelledby="users-range-label" style={{ display: 'inline-flex', gap: 'var(--sp-1)' }}>
          {RANGES.map((r) => (
            <Button
              key={r.value}
              variant={range === r.value ? 'primary' : 'secondary'}
              aria-pressed={range === r.value}
              onClick={() => setRange(r.value)}
            >
              {r.label}
            </Button>
          ))}
        </div>
      </div>
      {chartsError && (
        <p role="alert" style={{ margin: 0, color: 'var(--c-danger)' }}>
          {chartsError}
        </p>
      )}

      <div
        aria-busy={chartsLoading || undefined}
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
          gap: 'var(--sp-3)',
          opacity: chartsLoading ? 0.6 : 1,
        }}
      >
        <section style={{ ...panelStyle, padding: 'var(--sp-3) var(--sp-4)' }} aria-label="User growth">
          <h2 style={sectionHeading}>User growth</h2>
          <p style={{ margin: '0 0 var(--sp-2)', fontSize: 12, color: 'var(--c-text-3)' }}>Total users</p>
          {charts && charts.userGrowth.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={charts.userGrowth} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="var(--c-border-subtle)" vertical={false} />
                <XAxis
                  dataKey="bucket"
                  tickFormatter={charts.range === 'all' ? (v: string) => formatDate(v) : shortDate}
                  tick={axisTick}
                  axisLine={{ stroke: 'var(--c-border)' }}
                  tickLine={false}
                  minTickGap={16}
                />
                <YAxis
                  width={48}
                  tick={axisTick}
                  axisLine={false}
                  tickLine={false}
                  allowDecimals={false}
                  tickFormatter={(v: number) => formatNumber(v)}
                />
                <Tooltip
                  contentStyle={tooltipStyle}
                  labelFormatter={(v) => formatDate(String(v))}
                  formatter={(v) => [formatNumber(Number(v)), 'Total users']}
                />
                <Line
                  type="monotone"
                  dataKey="totalUsers"
                  name="Total users"
                  stroke="var(--c-primary)"
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <p style={{ margin: 0, height: 220, color: 'var(--c-text-3)' }}>
              {chartsLoading ? 'Loading…' : 'No data for this range.'}
            </p>
          )}
        </section>

        <section
          style={{ ...panelStyle, padding: 'var(--sp-3) var(--sp-4)' }}
          aria-label="Current tier by signup month"
        >
          <h2 style={sectionHeading}>Current tier by signup month</h2>
          <p style={{ margin: '0 0 var(--sp-2)', fontSize: 12 }}>
            {TIER_SERIES.map((s, i) => (
              <span key={s.key}>
                {i > 0 && <span style={{ color: 'var(--c-text-3)' }}> · </span>}
                <span style={{ color: s.color, fontWeight: 600 }}>{s.label}</span>
              </span>
            ))}
          </p>
          {charts && charts.tierBySignupMonth.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={charts.tierBySignupMonth} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="var(--c-border-subtle)" vertical={false} />
                <XAxis
                  dataKey="month"
                  tickFormatter={monthLabel}
                  tick={axisTick}
                  axisLine={{ stroke: 'var(--c-border)' }}
                  tickLine={false}
                  minTickGap={8}
                />
                <YAxis
                  width={48}
                  tick={axisTick}
                  axisLine={false}
                  tickLine={false}
                  allowDecimals={false}
                  tickFormatter={(v: number) => formatNumber(v)}
                />
                <Tooltip
                  contentStyle={tooltipStyle}
                  cursor={{ fill: 'var(--c-surface-inset)' }}
                  labelFormatter={(v) => monthLabel(String(v))}
                  formatter={(v, name) => [formatNumber(Number(v)), name]}
                />
                {TIER_SERIES.map((s) => (
                  <Bar
                    key={s.key}
                    dataKey={s.key}
                    name={s.label}
                    stackId="tier"
                    fill={s.color}
                    isAnimationActive={false}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <p style={{ margin: 0, height: 220, color: 'var(--c-text-3)' }}>
              {chartsLoading ? 'Loading…' : 'No data for this range.'}
            </p>
          )}
        </section>
      </div>

      <p style={{ margin: 0, color: 'var(--c-text-2)' }}>
        Active guest sessions (last 7 days, approximate): {stat(summary?.activeGuestSessions7d)}
      </p>

      <h2 style={sectionHeading}>Accounts</h2>
      <p style={{ margin: 0, color: 'var(--c-text-2)' }}>
        A Stripe event overwrites a comped tier, so comp only accounts without a subscription.
      </p>

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 'var(--sp-3)' }}>
        <label style={labelStyle}>
          Search by email
          <input
            type="search"
            value={emailInput}
            onChange={(e) => setEmailInput(e.target.value)}
            placeholder="name@example.com"
            style={{ ...controlStyle, width: 280 }}
          />
        </label>
        <span style={{ marginLeft: 'auto', color: 'var(--c-text-2)', alignSelf: 'center' }}>
          {list
            ? list.total !== null
              ? `${formatNumber(list.total)} accounts`
              : `${formatNumber(list.data.length)} matches${list.data.length >= 20 ? ' (first 20)' : ''}`
            : ''}
        </span>
      </div>

      {error && (
        <p role="alert" style={{ margin: 0, color: 'var(--c-danger)' }}>
          {error}
        </p>
      )}

      <div style={{ ...panelStyle, overflow: 'hidden' }}>
        <DataTable
          columns={columns}
          rows={list?.data ?? []}
          rowKey={(r) => r.id}
          onRowClick={(r) => openPanel(r.id)}
          selectedKey={selectedId}
          emptyText={email ? 'No accounts match this email.' : 'No accounts yet.'}
          loading={loading}
        />
      </div>

      {list && list.total !== null && list.total > 0 && (
        <Pager page={page} pageSize={PAGE_SIZE} total={list.total} onPageChange={setPage} />
      )}

      {selectedId !== null && (
        <aside
          aria-label="Account details"
          style={{
            position: 'fixed',
            top: 0,
            right: 0,
            bottom: 0,
            width: 400,
            maxWidth: '100%',
            boxSizing: 'border-box',
            zIndex: 200,
            overflowY: 'auto',
            padding: 'var(--sp-4) var(--sp-5)',
            background: 'var(--c-surface)',
            borderLeft: '1px solid var(--c-border)',
            boxShadow: 'var(--shadow-lg)',
            fontFamily: 'var(--font-ui)',
            fontSize: 14,
            color: 'var(--c-text)',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--sp-4)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--sp-3)' }}>
            <h2 style={{ ...sectionHeading, fontSize: 16, overflowWrap: 'anywhere' }}>
              {detail ? detail.email : 'Account details'}
            </h2>
            <Button ref={closeRef} variant="ghost" onClick={closePanel}>
              Close
            </Button>
          </div>

          {detailLoading && <p style={{ margin: 0, color: 'var(--c-text-3)' }}>Loading…</p>}
          {detailError && (
            <p role="alert" style={{ margin: 0, color: 'var(--c-danger)' }}>
              {detailError}
            </p>
          )}

          {detail && (
            <>
              <AccountFields detail={detail} />
              {detail.stripe_subscription_id && (
                <p
                  style={{
                    margin: 0,
                    padding: 'var(--sp-2) var(--sp-3)',
                    background: 'var(--c-warning-bg)',
                    borderRadius: 'var(--r-md)',
                    color: 'var(--c-text)',
                  }}
                >
                  This account has a Stripe subscription. Its next Stripe update will overwrite a comp.
                </p>
              )}
              <div>{actionButtons(detail, 'panel')}</div>
            </>
          )}
        </aside>
      )}

      <ConfirmDialog
        open={pending !== null}
        title={pending ? actionTitle(pending) : ''}
        message={pending ? actionMessage(pending) : ''}
        confirmLabel={pending ? actionLabel(pending) : ''}
        variant={
          pending &&
          ((pending.kind === 'tier' && pending.next === 'free') || (pending.kind === 'role' && pending.next === 'user'))
            ? 'danger'
            : 'primary'
        }
        busy={busy}
        error={actionError}
        onConfirm={confirmAction}
        onCancel={() => {
          setPending(null);
          setActionError(null);
        }}
      >
        {pending?.kind === 'role' && isPasswordAccount && (
          <label style={labelStyle}>
            Your password
            <input
              type="password"
              autoComplete="current-password"
              value={rolePassword}
              onChange={(e) => {
                setRolePassword(e.target.value);
                setPasswordHint(false);
              }}
              style={{ ...controlStyle, width: '100%' }}
            />
            {passwordHint && (
              <span style={{ fontSize: 12, color: 'var(--c-danger)' }}>Enter your password to confirm.</span>
            )}
          </label>
        )}
        {pending?.kind === 'role' && reauthRequired && (
          <p style={{ margin: 0, fontSize: 13, color: 'var(--c-danger)' }}>
            For security, sign in again to change roles.{' '}
            <a href="/api/auth/oauth/google?returnTo=%2Fadmin%2Fusers">Sign in again</a>
          </p>
        )}
      </ConfirmDialog>
    </div>
  );
}

function AccountFields({ detail }: { detail: AccountDetail }) {
  const zone = detail.zone
    ? detail.zone_location_label
      ? `${detail.zone} · ${detail.zone_location_label}`
      : detail.zone
    : EMPTY;
  const rows: Array<[string, string]> = [
    ['Email', detail.email],
    ['Name', detail.display_name ?? EMPTY],
    ['Role', detail.role],
    ['Tier', tierLabel(detail)],
    ['Period ends', formatDate(detail.subscription_period_end)],
    ['Cancels at', formatDate(detail.subscription_cancelled_at)],
    ['Zone', zone],
    ['Gardens', formatNumber(detail.gardenCount)],
    ['Stripe customer', detail.stripe_customer_id ?? 'None'],
    ['Stripe subscription', detail.stripe_subscription_id ?? 'None'],
    ['Signed up', formatDate(detail.created_at)],
    ['Last active', formatDate(detail.last_active_at)],
    ['Updated', formatDate(detail.updated_at)],
  ];
  return (
    <dl
      style={{
        display: 'grid',
        gridTemplateColumns: 'max-content 1fr',
        columnGap: 'var(--sp-4)',
        rowGap: 'var(--sp-2)',
        margin: 0,
      }}
    >
      {rows.map(([label, value]) => (
        <div key={label} style={{ display: 'contents' }}>
          <dt style={{ color: 'var(--c-text-2)' }}>{label}</dt>
          <dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
