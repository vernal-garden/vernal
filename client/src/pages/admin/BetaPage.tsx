import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  adminApi,
  apiErrorMessage,
  type BetaInvite,
  type BetaInvitesResult,
  type BetaOverview,
  type BetaSettingKey,
} from '../../lib/adminApi';
import { ApiError } from '../../lib/api';
import { ADMIN_BETA_COPY as COPY } from '../../lib/betaCopy';
import Switch from '../../components/Switch';
import Button from '../../components/admin/Button';
import ConfirmDialog from '../../components/admin/ConfirmDialog';
import DataTable, { type DataTableColumn, type SortDirection } from '../../components/admin/DataTable';
import StatCard from '../../components/admin/StatCard';
import { formatDate, formatDateTime, formatNumber } from '../../components/admin/format';

const SAVED_CLEAR_MS = 5000;

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

const noteStyle: CSSProperties = { margin: 'var(--sp-1) 0 0', fontSize: 13, color: 'var(--c-text-3)' };

const statusLine: CSSProperties = { minHeight: 20, fontSize: 13, lineHeight: '20px' };

type RowStatus = 'saved' | 'failed' | null;

type Sort = { key: string; dir: SortDirection };

type RemoveNotice = { text: string; failed: boolean };

function entriesIn(text: string): string[] {
  return text.split(/[\s,]+/).filter((t) => t !== '');
}

function compareInvites(a: BetaInvite, b: BetaInvite, key: string): number {
  if (key === 'email') return a.email.localeCompare(b.email);
  if (key === 'account') {
    // Accounts sort by sign-up date; emails without one sit together at the old end.
    const at = a.accountCreatedAt ? Date.parse(a.accountCreatedAt) : -Infinity;
    const bt = b.accountCreatedAt ? Date.parse(b.accountCreatedAt) : -Infinity;
    return at === bt ? 0 : at < bt ? -1 : 1;
  }
  return Date.parse(a.addedAt) - Date.parse(b.addedAt);
}

function Group({ heading, children }: { heading: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)' }}>
      <h2 id={id} style={sectionHeading}>
        {heading}
      </h2>
      {children}
    </section>
  );
}

interface SettingRowProps {
  label: string;
  description: string;
  checked: boolean;
  busy: boolean;
  status: RowStatus;
  onToggle: () => void;
  /** Draws the rule above the row. */
  divided?: boolean;
  /** Extra lines under the description. */
  children?: ReactNode;
}

function SettingRow({ label, description, checked, busy, status, onToggle, divided, children }: SettingRowProps) {
  const labelId = useId();
  const descriptionId = useId();
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 'var(--sp-4)',
        padding: 'var(--sp-4)',
        borderTop: divided ? '1px solid var(--c-border)' : undefined,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div id={labelId} style={{ fontSize: 14, fontWeight: 600, lineHeight: '20px', color: 'var(--c-text)' }}>
          {label}
        </div>
        <p id={descriptionId} style={{ margin: 'var(--sp-1) 0 0', fontSize: 13, color: 'var(--c-text-2)' }}>
          {description}
        </p>
        {children}
        <div style={{ ...statusLine, marginTop: 'var(--sp-1)' }}>
          <span role="status" style={{ color: 'var(--c-text-2)' }}>
            {status === 'saved' ? COPY.saved : ''}
          </span>
          {status === 'failed' && (
            <span role="alert" style={{ color: 'var(--c-danger)' }}>
              {COPY.saveFailed}
            </span>
          )}
        </div>
      </div>
      {/* The negative margin centres the 44px hit area on the 20px label line. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-1)', flexShrink: 0, marginTop: -12 }}>
        <span aria-hidden="true" style={{ fontSize: 13, fontWeight: 600, color: 'var(--c-text)' }}>
          {checked ? COPY.on : COPY.off}
        </span>
        <Switch
          checked={checked}
          busy={busy}
          outlined
          labelledBy={labelId}
          describedBy={descriptionId}
          onClick={(e) => {
            // Safari doesn't focus a clicked button, and ConfirmDialog returns focus to what had it.
            e.currentTarget.focus();
            onToggle();
          }}
        />
      </div>
    </div>
  );
}

export default function BetaPage() {
  // ── Overview and list ──
  const [overview, setOverview] = useState<BetaOverview | null>(null);
  const [invites, setInvites] = useState<BetaInvite[] | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const refreshReq = useRef(0);

  const refresh = useCallback(async () => {
    const id = ++refreshReq.current;
    try {
      const [next, list] = await Promise.all([adminApi.betaOverview(), adminApi.betaInvites()]);
      if (id !== refreshReq.current) return;
      // Only the counts: a switch value read here could undo a save in flight. applySetting settles the switches.
      setOverview((prev) => (prev ? { ...prev, counts: next.counts } : next));
      setInvites(list.data);
      setRefreshError(null);
    } catch {
      if (id !== refreshReq.current) return;
      setRefreshError(COPY.refreshFailed);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // ── Switches ──
  // One save at a time, so a PATCH response can't overwrite another switch's change.
  const [saving, setSaving] = useState<BetaSettingKey | null>(null);
  const [statuses, setStatuses] = useState<Record<BetaSettingKey, RowStatus>>({
    gateOn: null,
    guestModeOn: null,
    supporterAccessOn: null,
  });
  const [confirming, setConfirming] = useState<'gateOn' | 'supporterAccessOn' | null>(null);
  const savedTimers = useRef<Partial<Record<BetaSettingKey, number>>>({});
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    const timers = savedTimers.current;
    return () => {
      mounted.current = false;
      Object.values(timers).forEach((t) => window.clearTimeout(t));
    };
  }, []);

  const setStatus = (key: BetaSettingKey, status: RowStatus) =>
    setStatuses((prev) => ({ ...prev, [key]: status }));

  async function applySetting(key: BetaSettingKey, next: boolean) {
    window.clearTimeout(savedTimers.current[key]);
    setStatus(key, null);
    setSaving(key);
    setOverview((prev) => (prev ? { ...prev, [key]: next } : prev));
    const showSaved = () => {
      setStatus(key, 'saved');
      savedTimers.current[key] = window.setTimeout(() => setStatus(key, null), SAVED_CLEAR_MS);
    };
    try {
      const res = await adminApi.setBetaSetting(key, next);
      if (!mounted.current) return;
      setOverview(res);
      showSaved();
    } catch {
      // A failed PATCH doesn't prove the write failed: the server reads the
      // overview after COMMIT, and a response can be lost. Ask what stuck.
      try {
        const fresh = await adminApi.betaOverview();
        if (!mounted.current) return;
        setOverview(fresh);
        if (fresh[key] === next) showSaved();
        else setStatus(key, 'failed');
      } catch {
        setOverview((prev) => (prev ? { ...prev, [key]: !next } : prev));
        setStatus(key, 'failed');
      }
    } finally {
      setSaving(null);
    }
  }

  function toggle(key: BetaSettingKey) {
    if (!overview || saving) return;
    const next = !overview[key];
    if (next || key === 'guestModeOn') {
      applySetting(key, next);
      return;
    }
    setConfirming(key);
    // The dialog quotes the participant count, which goes stale on a page left open.
    if (key === 'supporterAccessOn') refresh();
  }

  function confirmOff() {
    if (!confirming) return;
    setConfirming(null);
    applySetting(confirming, false);
  }

  // ── Add form ──
  const [text, setText] = useState('');
  const [adding, setAdding] = useState(false);
  const [result, setResult] = useState<BetaInvitesResult | null>(null);
  // Kept apart from result, which clears on submit: these stay flagged until a response replaces them.
  const [lastInvalid, setLastInvalid] = useState<string[]>([]);
  const [addError, setAddError] = useState<string | null>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const helperId = useId();

  const entries = entriesIn(text);
  const invalidInField = lastInvalid.filter((e) => entries.includes(e));

  async function submit() {
    if (adding || entries.length === 0) return;
    setAdding(true);
    setResult(null);
    setAddError(null);
    try {
      const res = await adminApi.addBetaInvites(text);
      setResult(res);
      setLastInvalid(res.invalid);
      setText(res.invalid.join('\n'));
      refresh();
    } catch (err: unknown) {
      // 4xx text is meant for the admin (the 500-address limit); 5xx text isn't.
      setAddError(err instanceof ApiError && err.status < 500 ? apiErrorMessage(err, COPY.add.failed) : COPY.add.failed);
    } finally {
      setAdding(false);
      // Add goes disabled, so its focus moves to the field. Focus that went elsewhere stays there.
      const active = document.activeElement;
      if (active === document.body || active === addRef.current) fieldRef.current?.focus();
    }
  }

  function onFormSubmit(e: FormEvent) {
    e.preventDefault();
    submit();
  }

  function onFieldKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      submit();
    }
  }

  // ── Table ──
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<Sort>({ key: 'added', dir: 'desc' });
  const [removing, setRemoving] = useState<number | null>(null);
  const [removeNotice, setRemoveNotice] = useState<RemoveNotice | null>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // Row position of the last removal, so focus can move off the button that went with it.
  const removedAt = useRef<number | null>(null);

  const rows = useMemo(() => {
    const query = search.trim().toLowerCase();
    const matched = (invites ?? []).filter((i) => i.email.includes(query));
    const sign = sort.dir === 'asc' ? 1 : -1;
    // Rows from one paste share added_at, so id settles ties, in the sort's direction.
    return [...matched].sort((a, b) => sign * (compareInvites(a, b, sort.key) || a.id - b.id));
  }, [invites, search, sort]);

  useEffect(() => {
    const index = removedAt.current;
    if (index === null) return;
    removedAt.current = null;
    if (document.activeElement !== document.body) return;
    const buttons = tableRef.current?.querySelectorAll<HTMLButtonElement>('tbody button');
    const next = buttons?.[Math.min(index, buttons.length - 1)];
    (next ?? searchRef.current)?.focus();
  }, [invites]);

  async function remove(invite: BetaInvite) {
    if (removing !== null) return;
    setRemoving(invite.id);
    setRemoveNotice(null);
    try {
      let notice = COPY.table.removed(invite.email, invite.accountCreatedAt !== null);
      try {
        await adminApi.removeBetaInvite(invite.id);
      } catch (err: unknown) {
        if (!(err instanceof ApiError && err.status === 404)) throw err;
        notice = COPY.table.alreadyGone(invite.email);
      }
      setRemoveNotice({ text: notice, failed: false });
      removedAt.current = rows.indexOf(invite);
      setInvites((prev) => (prev ? prev.filter((i) => i.id !== invite.id) : prev));
      refresh();
    } catch {
      setRemoveNotice({ text: COPY.table.removeFailed(invite.email), failed: true });
    } finally {
      setRemoving(null);
    }
  }

  // ── Unused-invite cleanup ──
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [cleanupError, setCleanupError] = useState<string | null>(null);
  const [cleanupNotice, setCleanupNotice] = useState<string | null>(null);

  function openCleanup() {
    setCleanupNotice(null);
    setCleanupError(null);
    setCleanupOpen(true);
    // The dialog quotes the unused count, which goes stale on a page left open.
    refresh();
  }

  async function runCleanup() {
    if (cleaning) return;
    setCleaning(true);
    setCleanupError(null);
    try {
      const res = await adminApi.cleanupBetaInvites();
      if (!mounted.current) return;
      setCleanupOpen(false);
      setCleanupNotice(COPY.cleanup.removed(res.removed));
      refresh();
    } catch {
      if (mounted.current) setCleanupError(COPY.cleanup.failed);
    } finally {
      if (mounted.current) setCleaning(false);
    }
  }

  const columns: Array<DataTableColumn<BetaInvite>> = [
    {
      key: 'email',
      header: COPY.table.email,
      sortable: true,
      // DataTable truncates; long emails wrap here instead.
      render: (r) => (
        <span
          style={{ display: 'block', padding: 'var(--sp-1) 0', whiteSpace: 'normal', overflowWrap: 'anywhere' }}
        >
          {r.email}
        </span>
      ),
    },
    {
      key: 'added',
      header: COPY.table.added,
      sortable: true,
      defaultDir: 'desc',
      width: 120,
      render: (r) => formatDate(r.addedAt),
    },
    {
      key: 'account',
      header: COPY.table.account,
      sortable: true,
      defaultDir: 'desc',
      width: 160,
      render: (r) => (r.accountCreatedAt ? COPY.table.yes(formatDate(r.accountCreatedAt)) : COPY.table.no),
    },
    {
      key: 'actions',
      header: COPY.table.actions,
      width: 104,
      render: (r) => (
        <Button
          variant="ghost"
          aria-label={COPY.table.removeLabel(r.email)}
          aria-disabled={removing !== null || undefined}
          style={{ height: 28, opacity: removing === r.id ? 0.55 : 1 }}
          onClick={() => remove(r)}
        >
          {COPY.table.remove}
        </Button>
      ),
    },
  ];

  if (!overview || !invites) {
    return (
      <div style={{ padding: 'var(--sp-5)', display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 'var(--sp-3)' }}>
        {refreshError ? (
          <>
            <p role="alert" style={{ margin: 0, color: 'var(--c-danger)' }}>
              {COPY.loadFailed}
            </p>
            <Button onClick={refresh}>{COPY.retry}</Button>
          </>
        ) : (
          <p style={{ margin: 0, color: 'var(--c-text-3)' }}>Loading…</p>
        )}
      </div>
    );
  }

  const { participants } = overview.counts;
  const unused = overview.counts.invited - overview.counts.haveAccounts;

  return (
    <div
      style={{
        boxSizing: 'content-box',
        maxWidth: 720,
        padding: 'var(--sp-5)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--sp-6)',
      }}
    >
      <Group heading={COPY.accessHeading}>
        <div style={panelStyle}>
          <SettingRow
            label={COPY.gate.label}
            description={COPY.gate.description}
            checked={overview.gateOn}
            busy={saving !== null}
            status={statuses.gateOn}
            onToggle={() => toggle('gateOn')}
          >
            {overview.gateOn && overview.gateFirstOnAt && (
              <p style={noteStyle}>{COPY.gate.firstOn(formatDateTime(overview.gateFirstOnAt))}</p>
            )}
          </SettingRow>
          <SettingRow
            label={COPY.guestMode.label}
            description={COPY.guestMode.description}
            checked={overview.guestModeOn}
            busy={saving !== null}
            status={statuses.guestModeOn}
            onToggle={() => toggle('guestModeOn')}
            divided
          />
        </div>
      </Group>

      <Group heading={COPY.testersHeading}>
        <div style={panelStyle}>
          <SettingRow
            label={COPY.supporter.label}
            description={COPY.supporter.description}
            checked={overview.supporterAccessOn}
            busy={saving !== null}
            status={statuses.supporterAccessOn}
            onToggle={() => toggle('supporterAccessOn')}
          >
            <p style={noteStyle}>{COPY.supporter.separate}</p>
            <p style={noteStyle}>{COPY.supporter.count(participants)}</p>
          </SettingRow>
        </div>
      </Group>

      <Group heading={COPY.inviteHeading}>
        <div
          style={{ ...panelStyle, padding: 'var(--sp-4)', display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)' }}
        >
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 'var(--sp-3)' }}>
            <StatCard label={COPY.counts.invited} value={formatNumber(overview.counts.invited)} />
            <StatCard label={COPY.counts.haveAccounts} value={formatNumber(overview.counts.haveAccounts)} />
            <StatCard label={COPY.counts.participants} value={formatNumber(participants)} />
          </div>

          <form onSubmit={onFormSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}>
            <label style={labelStyle}>
              {COPY.add.label}
              <textarea
                ref={fieldRef}
                rows={3}
                value={text}
                readOnly={adding}
                aria-invalid={invalidInField.length > 0 || undefined}
                aria-describedby={helperId}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={onFieldKeyDown}
                style={{
                  ...controlStyle,
                  width: '100%',
                  height: 'auto',
                  padding: 'var(--sp-2)',
                  resize: 'vertical',
                }}
              />
            </label>
            <p id={helperId} style={{ margin: 0, fontSize: 13, color: 'var(--c-text-2)' }}>
              {COPY.add.helper}
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Button ref={addRef} type="submit" variant="primary" disabled={adding || entries.length === 0}>
                {COPY.add.button}
              </Button>
            </div>
            <div
              role="status"
              style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-1)', fontSize: 13, color: 'var(--c-text-2)' }}
            >
              {result && result.added.length > 0 && <div>{COPY.add.added(result.added.length)}</div>}
              {result && result.alreadyListed.length > 0 && (
                <div>{COPY.add.alreadyListed(result.alreadyListed.length)}</div>
              )}
              {result && result.newParticipants.length > 0 && (
                <div>{COPY.add.newParticipants(result.newParticipants.length)}</div>
              )}
              {invalidInField.length > 0 && (
                <div style={{ color: 'var(--c-danger)', overflowWrap: 'anywhere' }}>
                  {COPY.add.invalid(invalidInField)}
                </div>
              )}
            </div>
            {addError && (
              <p role="alert" style={{ margin: 0, fontSize: 13, color: 'var(--c-danger)' }}>
                {addError}
              </p>
            )}
          </form>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}>
            <label style={labelStyle}>
              {COPY.table.search}
              <input
                ref={searchRef}
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="name@example.com"
                style={{ ...controlStyle, width: 280 }}
              />
            </label>

            {refreshError && (
              <p role="alert" style={{ margin: 0, fontSize: 13, color: 'var(--c-danger)' }}>
                {refreshError}
              </p>
            )}

            <div style={statusLine}>
              <span role="status" style={{ color: 'var(--c-text-2)', overflowWrap: 'anywhere' }}>
                {removeNotice && !removeNotice.failed ? removeNotice.text : ''}
              </span>
              {removeNotice?.failed && (
                <span role="alert" style={{ color: 'var(--c-danger)', overflowWrap: 'anywhere' }}>
                  {removeNotice.text}
                </span>
              )}
            </div>

            <div ref={tableRef}>
              <DataTable
                columns={columns}
                rows={rows}
                rowKey={(r) => r.id}
                sort={sort}
                onSortChange={(key, dir) => setSort({ key, dir })}
                emptyText={invites.length === 0 ? COPY.table.empty : COPY.table.noMatch}
              />
            </div>
          </div>

          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 'var(--sp-4)',
              paddingTop: 'var(--sp-4)',
              borderTop: '1px solid var(--c-border)',
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 600, lineHeight: '20px', color: 'var(--c-text)' }}>
                {COPY.cleanup.label}
              </div>
              <p style={{ margin: 'var(--sp-1) 0 0', fontSize: 13, color: 'var(--c-text-2)' }}>
                {COPY.cleanup.description}
              </p>
              <div style={{ ...statusLine, marginTop: 'var(--sp-1)' }}>
                <span role="status" style={{ color: 'var(--c-text-2)' }}>
                  {cleanupNotice ?? ''}
                </span>
              </div>
            </div>
            <Button variant="danger" style={{ flexShrink: 0 }} onClick={openCleanup}>
              {COPY.cleanup.button}
            </Button>
          </div>
        </div>
      </Group>

      <ConfirmDialog
        open={confirming !== null}
        title={confirming === 'gateOn' ? COPY.gate.confirmTitle : COPY.supporter.confirmTitle}
        message={confirming === 'gateOn' ? COPY.gate.confirmBody : COPY.supporter.confirmBody(participants)}
        confirmLabel={confirming === 'gateOn' ? COPY.gate.confirmLabel : COPY.supporter.confirmLabel}
        variant={confirming === 'gateOn' ? 'danger' : 'primary'}
        error={confirming === 'supporterAccessOn' ? refreshError : null}
        onConfirm={confirmOff}
        onCancel={() => setConfirming(null)}
      />
      <ConfirmDialog
        open={cleanupOpen}
        title={COPY.cleanup.confirmTitle}
        message={COPY.cleanup.confirmBody(unused)}
        confirmLabel={COPY.cleanup.confirmLabel}
        variant="danger"
        busy={cleaning}
        error={cleanupError ?? refreshError}
        onConfirm={runCleanup}
        onCancel={() => setCleanupOpen(false)}
      />
    </div>
  );
}
