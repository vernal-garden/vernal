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
import { adminApi, type BetaLifetime, type BetaLifetimeRow, type BetaSurveyCreditsResult } from '../../lib/adminApi';
import { ApiError } from '../../lib/api';
import { ADMIN_LIFETIME_COPY as COPY } from '../../lib/betaCopy';
import {
  feedbackSplit,
  formatWeeks,
  inGroup,
  statusOf,
  statusRank,
  windowEndDay,
  type LifetimeGroup,
} from '../../lib/lifetimeView';
import { OUTSIDE_US } from '../../lib/usStates';
import BetaSubnav from '../../components/admin/BetaSubnav';
import Button, { buttonStyle } from '../../components/admin/Button';
import DataTable, { type DataTableColumn, type SortDirection } from '../../components/admin/DataTable';
import Pager from '../../components/admin/Pager';
import StatCard from '../../components/admin/StatCard';
import { formatDate, formatNumber } from '../../components/admin/format';

const SAVED_CLEAR_MS = 5000;

// Above this many rows (after filter and search) the table pages.
const PAGE_THRESHOLD = 200;
const PAGE_SIZE = 50;

const CSV_URL = '/api/admin/beta/lifetime?format=csv';

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

const statusLine: CSSProperties = { minHeight: 20, fontSize: 13, lineHeight: '20px' };

const secondaryText: CSSProperties = { color: 'var(--c-text-2)' };

const segmentGroupStyle: CSSProperties = {
  display: 'inline-flex',
  border: '1px solid var(--c-border)',
  borderRadius: 'var(--r-md)',
  overflow: 'hidden',
  background: 'var(--c-surface)',
};

function segmentStyle(active: boolean, first: boolean): CSSProperties {
  return {
    height: 34,
    padding: '0 var(--sp-3)',
    border: 'none',
    borderLeft: first ? 'none' : '1px solid var(--c-border)',
    background: active ? 'var(--c-primary)' : 'transparent',
    color: active ? 'var(--c-text-on-primary)' : 'var(--c-text-2)',
    fontFamily: 'var(--font-ui)',
    fontSize: 14,
    fontWeight: active ? 600 : 400,
    whiteSpace: 'nowrap',
    cursor: 'pointer',
  };
}

const FILTERS: LifetimeGroup[] = ['all', 'qualify', 'close', 'noState', 'eligible', 'notYet'];

const SURVEYS = [1, 2] as const;
type Survey = (typeof SURVEYS)[number];

type Sort = { key: string; dir: SortDirection };

type Notice = { text: string; failed: boolean };

function byEmail(a: BetaLifetimeRow, b: BetaLifetimeRow): number {
  return a.email.localeCompare(b.email);
}

// The order before any header is clicked: status, then email.
function defaultOrder(a: BetaLifetimeRow, b: BetaLifetimeRow): number {
  return statusRank(a) - statusRank(b) || byEmail(a, b);
}

function compareRows(a: BetaLifetimeRow, b: BetaLifetimeRow, key: string): number {
  switch (key) {
    case 'email': return byEmail(a, b);
    case 'joined': return Date.parse(a.participantAt) - Date.parse(b.participantAt);
    case 'weeks': return a.activeWeekCount - b.activeWeekCount;
    case 'feedback': return a.feedback.total - b.feedback.total;
    case 'surveys': return a.surveyCredits.length - b.surveyCredits.length;
    case 'status': return statusRank(a) - statusRank(b);
    case 'state': return (a.residenceState ?? '').localeCompare(b.residenceState ?? '');
    // Eligible first.
    case 'grant': return Number(b.grantEligible) - Number(a.grantEligible);
    default: return 0;
  }
}

function sortRows(rows: BetaLifetimeRow[], sort: Sort | null): BetaLifetimeRow[] {
  if (!sort) return [...rows].sort(defaultOrder);
  const sign = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    // Testers with no state answer sit at the end in both directions.
    if (sort.key === 'state' && (a.residenceState === null) !== (b.residenceState === null)) {
      return a.residenceState === null ? 1 : -1;
    }
    return sign * compareRows(a, b, sort.key) || byEmail(a, b);
  });
}

function withCredit(credits: number[], survey: Survey, on: boolean): number[] {
  const rest = credits.filter((c) => c !== survey);
  return on ? [...rest, survey].sort((x, y) => x - y) : rest;
}

function Section({ heading, children }: { heading: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)' }}>
      <h3 id={id} style={sectionHeading}>
        {heading}
      </h3>
      {children}
    </section>
  );
}

export default function LifetimePage() {
  // ── Data ──
  const [data, setData] = useState<BetaLifetime | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const refreshReq = useRef(0);
  const mounted = useRef(false);
  const noticeTimer = useRef<number | undefined>(undefined);

  const refresh = useCallback(async () => {
    const id = ++refreshReq.current;
    try {
      const next = await adminApi.betaLifetime();
      if (id !== refreshReq.current) return;
      setData(next);
      setRefreshError(null);
    } catch {
      if (id !== refreshReq.current) return;
      setRefreshError(COPY.loadFailed);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      window.clearTimeout(noticeTimer.current);
    };
  }, []);

  // ── Filter, search, sort, page ──
  const [filter, setFilter] = useState<LifetimeGroup>('all');
  const [search, setSearch] = useState('');
  // null: the default order, which no single column header describes.
  const [sort, setSort] = useState<Sort | null>(null);
  const [page, setPage] = useState(1);

  const allRows = useMemo(() => data?.rows ?? [], [data]);
  const groupRows = useMemo(() => allRows.filter((r) => inGroup(r, filter)), [allRows, filter]);
  const rows = useMemo(() => {
    const query = search.trim().toLowerCase();
    return sortRows(
      groupRows.filter((r) => r.email.toLowerCase().includes(query)),
      sort,
    );
  }, [groupRows, search, sort]);

  const paged = rows.length > PAGE_THRESHOLD;
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages);
  const shown = paged ? rows.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE) : rows;

  function chooseFilter(group: LifetimeGroup) {
    setFilter(group);
    setPage(1);
  }

  const emptyText =
    allRows.length === 0 ? COPY.table.empty : groupRows.length === 0 ? COPY.table.emptyGroup : COPY.table.noMatch;

  // ── Credit a survey ──
  const [survey, setSurvey] = useState<Survey | null>(null);
  const [text, setText] = useState('');
  const [crediting, setCrediting] = useState(false);
  const [result, setResult] = useState<{ survey: Survey; res: BetaSurveyCreditsResult } | null>(null);
  const [creditError, setCreditError] = useState(false);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const creditRef = useRef<HTMLButtonElement>(null);
  const creditHeadingId = useId();
  const helperId = useId();

  const canCredit = !crediting && survey !== null && text.trim() !== '';

  async function submitCredit() {
    if (!canCredit || survey === null) return;
    setCrediting(true);
    setResult(null);
    setCreditError(false);
    try {
      const res = await adminApi.creditSurveys(survey, text);
      if (!mounted.current) return;
      setResult({ survey, res });
      // Only the entries that need another look stay in the field.
      setText([...res.notParticipants, ...res.invalid].join('\n'));
      refresh();
    } catch {
      if (mounted.current) setCreditError(true);
    } finally {
      if (mounted.current) {
        setCrediting(false);
        // Credit goes disabled, so its focus moves to the field. Focus that went elsewhere stays there.
        const active = document.activeElement;
        if (active === document.body || active === creditRef.current) fieldRef.current?.focus();
      }
    }
  }

  function onCreditSubmit(e: FormEvent) {
    e.preventDefault();
    submitCredit();
  }

  function onFieldKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      submitCredit();
    }
  }

  // ── Survey toggles ──
  // The value each toggle in flight is heading to, keyed `${accountId}:${survey}`.
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState<Notice | null>(null);

  async function toggleSurvey(row: BetaLifetimeRow, s: Survey) {
    const key = `${row.accountId}:${s}`;
    if (key in pending) return;
    const next = !row.surveyCredits.includes(s);
    setPending((prev) => ({ ...prev, [key]: next }));
    window.clearTimeout(noticeTimer.current);
    setNotice(null);
    try {
      try {
        if (next) await adminApi.addSurveyCredit(row.accountId, s);
        else await adminApi.removeSurveyCredit(row.accountId, s);
      } catch (err: unknown) {
        // 409 on add and 404 on remove mean the server already matches.
        if (!(err instanceof ApiError && err.status === (next ? 409 : 404))) throw err;
      }
      if (!mounted.current) return;
      setData((prev) =>
        prev
          ? {
              ...prev,
              rows: prev.rows.map((r) =>
                r.accountId === row.accountId ? { ...r, surveyCredits: withCredit(r.surveyCredits, s, next) } : r,
              ),
            }
          : prev,
      );
      window.clearTimeout(noticeTimer.current);
      setNotice({ text: next ? COPY.table.added(s, row.email) : COPY.table.removed(s, row.email), failed: false });
      noticeTimer.current = window.setTimeout(() => setNotice(null), SAVED_CLEAR_MS);
      // Feedback, status, grant and the summary all follow from the credit.
      refresh();
    } catch {
      if (mounted.current) {
        window.clearTimeout(noticeTimer.current);
        setNotice({ text: COPY.table.failed, failed: true });
      }
    } finally {
      if (mounted.current) {
        setPending((prev) => {
          const rest = { ...prev };
          delete rest[key];
          return rest;
        });
      }
    }
  }

  const columns: Array<DataTableColumn<BetaLifetimeRow>> = [
    {
      key: 'email',
      header: COPY.table.email,
      sortable: true,
      // DataTable truncates; long emails wrap here instead.
      render: (r) => (
        <span style={{ display: 'block', padding: 'var(--sp-1) 0', whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
          {r.email}
        </span>
      ),
      title: (r) => r.email,
    },
    {
      key: 'joined',
      header: COPY.table.joined,
      sortable: true,
      width: 136,
      render: (r) => (
        <>
          {formatDate(r.participantAt)}
          {r.joinedVia && (
            <span style={secondaryText}> · {r.joinedVia === 'invite' ? COPY.table.invite : COPY.table.guest}</span>
          )}
        </>
      ),
      title: (r) => formatDate(r.participantAt),
    },
    {
      key: 'weeks',
      header: COPY.table.weeks,
      sortable: true,
      defaultDir: 'desc',
      width: 150,
      render: (r) => (
        <>
          {`${r.activeWeekCount}`}
          {r.activeWeeks.length > 0 && <span style={secondaryText}>{` · ${formatWeeks(r.activeWeeks)}`}</span>}
        </>
      ),
      title: (r) => (r.activeWeeks.length > 0 ? formatWeeks(r.activeWeeks) : `${r.activeWeekCount}`),
    },
    {
      key: 'feedback',
      header: COPY.table.feedback,
      sortable: true,
      defaultDir: 'desc',
      width: 160,
      render: (r) => {
        const split = feedbackSplit(r.feedback);
        return (
          <>
            {`${r.feedback.total}`}
            {split !== '' && <span style={secondaryText}>{` · ${split}`}</span>}
          </>
        );
      },
      title: (r) => feedbackSplit(r.feedback) || `${r.feedback.total}`,
    },
    {
      key: 'surveys',
      header: COPY.table.surveys,
      sortable: true,
      defaultDir: 'desc',
      // Room for both 28px toggles plus their focus rings: DataTable clips cells
      // at the padding box, and the 12px side padding and 4px above and below
      // keep the rings inside it.
      width: 96,
      render: (r) => (
        <span style={{ display: 'inline-flex', gap: 'var(--sp-1)' }}>
          {SURVEYS.map((s) => {
            const key = `${r.accountId}:${s}`;
            const on = pending[key] ?? r.surveyCredits.includes(s);
            return (
              <button
                key={s}
                type="button"
                aria-pressed={on}
                aria-label={COPY.table.toggleLabel(s, r.email)}
                onClick={() => toggleSurvey(r, s)}
                style={{ ...buttonStyle(on ? 'primary' : 'secondary'), height: 28, minWidth: 28, padding: '0 var(--sp-2)' }}
              >
                {s}
              </button>
            );
          })}
        </span>
      ),
      title: () => '',
    },
    {
      key: 'status',
      header: COPY.table.status,
      sortable: true,
      width: 88,
      render: (r) => statusOf(r),
    },
    {
      key: 'state',
      header: COPY.table.state,
      sortable: true,
      width: 112,
      render: (r) =>
        r.residenceState === OUTSIDE_US ? (
          COPY.table.outsideUs
        ) : r.residenceState ? (
          r.residenceState
        ) : (
          <span style={{ color: 'var(--c-text-3)' }}>{r.qualifies ? COPY.table.notAnswered : COPY.table.notAsked}</span>
        ),
    },
    {
      key: 'grant',
      header: COPY.table.grant,
      sortable: true,
      width: 80,
      render: (r) => (r.grantEligible ? COPY.table.eligible : ''),
    },
  ];

  if (!data) {
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

  const cards: Array<{ label: string; count: number; group: LifetimeGroup }> = [
    { label: COPY.cards.participants, count: allRows.length, group: 'all' },
    { label: COPY.cards.qualify, count: allRows.filter((r) => inGroup(r, 'qualify')).length, group: 'qualify' },
    { label: COPY.cards.close, count: allRows.filter((r) => inGroup(r, 'close')).length, group: 'close' },
    { label: COPY.cards.noState, count: allRows.filter((r) => inGroup(r, 'noState')).length, group: 'noState' },
    { label: COPY.cards.eligible, count: allRows.filter((r) => inGroup(r, 'eligible')).length, group: 'eligible' },
  ];

  return (
    <div
      style={{
        boxSizing: 'content-box',
        maxWidth: 960,
        padding: 'var(--sp-5)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--sp-6)',
      }}
    >
      <BetaSubnav />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-1)' }}>
        <h2 style={sectionHeading}>{COPY.heading}</h2>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--c-text-2)' }}>{COPY.window(windowEndDay(data.endsAt))}</p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 'var(--sp-3)' }}>
        {cards.map((c) => (
          <StatCard
            key={c.label}
            label={c.label}
            value={formatNumber(c.count)}
            onClick={() => chooseFilter(c.group)}
            pressed={filter === c.group}
          />
        ))}
      </div>

      <section aria-labelledby={creditHeadingId} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)' }}>
        <h3 id={creditHeadingId} style={sectionHeading}>
          {COPY.credit.heading}
        </h3>
        <form
          onSubmit={onCreditSubmit}
          style={{ ...panelStyle, padding: 'var(--sp-4)', display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}
        >
          <div role="radiogroup" aria-labelledby={creditHeadingId} style={{ display: 'flex', gap: 'var(--sp-4)' }}>
            {SURVEYS.map((s) => (
              <label key={s} style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--sp-1)', fontSize: 14, color: 'var(--c-text)' }}>
                <input
                  type="radio"
                  name="credit-survey"
                  value={s}
                  checked={survey === s}
                  disabled={crediting}
                  onChange={() => setSurvey(s)}
                />
                {s === 1 ? COPY.credit.survey1 : COPY.credit.survey2}
              </label>
            ))}
          </div>
          <label style={labelStyle}>
            {COPY.credit.label}
            <textarea
              ref={fieldRef}
              rows={3}
              value={text}
              readOnly={crediting}
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
            {COPY.credit.helper}
          </p>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button ref={creditRef} type="submit" variant="primary" disabled={!canCredit}>
              {COPY.credit.button}
            </Button>
          </div>
          <div
            role="status"
            style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-1)', fontSize: 13, color: 'var(--c-text-2)' }}
          >
            {result && result.res.credited.length > 0 && (
              <div>{COPY.credit.credited(result.res.credited.length, result.survey)}</div>
            )}
            {result && result.res.alreadyCredited.length > 0 && (
              <div>{COPY.credit.already(result.res.alreadyCredited.length, result.survey)}</div>
            )}
            {result && result.res.notParticipants.length > 0 && (
              <div style={{ color: 'var(--c-danger)', overflowWrap: 'anywhere' }}>
                {COPY.credit.notParticipants(result.res.notParticipants)}
              </div>
            )}
            {result && result.res.invalid.length > 0 && (
              <div style={{ color: 'var(--c-danger)', overflowWrap: 'anywhere' }}>{COPY.credit.invalid(result.res.invalid)}</div>
            )}
          </div>
          {creditError && (
            <p role="alert" style={{ margin: 0, fontSize: 13, color: 'var(--c-danger)' }}>
              {COPY.credit.failed}
            </p>
          )}
        </form>
      </section>

      <Section heading={COPY.table.heading}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 'var(--sp-3)' }}>
          <div role="group" aria-label="Filter testers" style={segmentGroupStyle}>
            {FILTERS.map((g, i) => (
              <button
                key={g}
                type="button"
                aria-pressed={filter === g}
                onClick={() => chooseFilter(g)}
                style={segmentStyle(filter === g, i === 0)}
              >
                {COPY.table.filters[g]}
              </button>
            ))}
          </div>
          <label style={labelStyle}>
            {COPY.table.search}
            <input
              type="search"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder={COPY.table.searchPlaceholder}
              style={{ ...controlStyle, width: 240 }}
            />
          </label>
          <a href={CSV_URL} style={{ ...buttonStyle('secondary'), marginLeft: 'auto' }}>
            {COPY.table.csv}
          </a>
        </div>

        {refreshError && (
          <p role="alert" style={{ margin: 0, fontSize: 13, color: 'var(--c-danger)' }}>
            {refreshError}
          </p>
        )}

        <div style={statusLine}>
          <span role="status" style={{ color: 'var(--c-text-2)', overflowWrap: 'anywhere' }}>
            {notice && !notice.failed ? notice.text : ''}
          </span>
          {notice?.failed && (
            <span role="alert" style={{ color: 'var(--c-danger)', overflowWrap: 'anywhere' }}>
              {notice.text}
            </span>
          )}
        </div>

        <DataTable
          columns={columns}
          rows={shown}
          rowKey={(r) => r.accountId}
          sort={sort ?? undefined}
          onSortChange={(key, dir) => {
            setSort({ key, dir });
            setPage(1);
          }}
          emptyText={emptyText}
        />

        {paged && <Pager page={currentPage} pageSize={PAGE_SIZE} total={rows.length} onPageChange={setPage} />}

        <p style={{ margin: 0, fontSize: 13, color: 'var(--c-text-2)' }}>{COPY.checkNote}</p>
      </Section>
    </div>
  );
}
