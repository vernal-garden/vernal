import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ApiError } from '../../lib/api';
import {
  adminApi,
  apiErrorMessage,
  type FeedbackCategory,
  type FeedbackDetail,
  type FeedbackList,
  type FeedbackStatus,
  type FeedbackStatusFilter,
} from '../../lib/adminApi';
import Button from '../../components/admin/Button';
import Chip from '../../components/admin/Chip';
import Pager from '../../components/admin/Pager';
import StatusDot, { type StatusDotKind } from '../../components/admin/StatusDot';
import TwoPanel from '../../components/admin/TwoPanel';
import { EMPTY, formatDateTime, formatRelative } from '../../components/admin/format';

const PAGE_SIZE = 50;
const PREVIEW_LEN = 80;

const STATUS_FILTERS: Array<{ value: FeedbackStatusFilter; label: string }> = [
  { value: 'active', label: 'Active' },
  { value: 'new', label: 'New' },
  { value: 'reviewed', label: 'Read' },
  { value: 'closed', label: 'Archived' },
  { value: 'everything', label: 'Everything' },
];

const CATEGORIES: Array<{ value: FeedbackCategory; label: string }> = [
  { value: 'bug', label: 'Bug' },
  { value: 'feature_request', label: 'Idea' },
  { value: 'general', label: 'Other' },
  { value: 'data_quality', label: 'Data' },
];

const CATEGORY_LABEL: Record<FeedbackCategory, string> = {
  bug: 'Bug',
  feature_request: 'Idea',
  general: 'Other',
  data_quality: 'Data',
};

const STATUS_LABEL: Record<FeedbackStatus, string> = {
  new: 'New',
  reviewed: 'Read',
  closed: 'Archived',
};

const STATUS_DOT: Record<FeedbackStatus, StatusDotKind> = {
  new: 'filled',
  reviewed: 'half',
  closed: 'empty',
};

const STATUS_BADGE_BG: Record<FeedbackStatus, string> = {
  new: 'var(--c-info-bg)',
  reviewed: 'var(--c-surface-raised)',
  closed: 'var(--c-surface-inset)',
};

interface Filters {
  status: FeedbackStatusFilter;
  category: FeedbackCategory | null;
  surface: string | null;
  page: number;
}

function parseStatus(value: string | null): FeedbackStatusFilter {
  return STATUS_FILTERS.some((s) => s.value === value) ? (value as FeedbackStatusFilter) : 'active';
}

function parseCategory(value: string | null): FeedbackCategory | null {
  return CATEGORIES.some((c) => c.value === value) ? (value as FeedbackCategory) : null;
}

function parseId(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  return Number(value);
}

function parsePage(value: string | null): number {
  if (!value || !/^\d+$/.test(value)) return 1;
  return Math.max(1, Number(value));
}

function truncatePreview(preview: string): string {
  return preview.length > PREVIEW_LEN ? `${preview.slice(0, PREVIEW_LEN)}…` : preview;
}

function isTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function CategoryChip({ category }: { category: FeedbackCategory }) {
  return <Chip>{CATEGORY_LABEL[category] ?? category}</Chip>;
}

const subdued: CSSProperties = { margin: 0, padding: 'var(--sp-5)', color: 'var(--c-text-3)' };

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

export default function FeedbackPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const status = parseStatus(searchParams.get('status'));
  const category = parseCategory(searchParams.get('category'));
  const surface = searchParams.get('surface') || null;
  const itemId = parseId(searchParams.get('item'));
  const page = parsePage(searchParams.get('page'));

  const [list, setList] = useState<FeedbackList | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [checked, setChecked] = useState<Set<number>>(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);

  const [detail, setDetail] = useState<FeedbackDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const listReq = useRef(0);
  const detailReq = useRef(0);
  // Latest filters / selected item, read by async handlers after an await.
  const filtersRef = useRef<Filters>({ status, category, surface, page });
  filtersRef.current = { status, category, surface, page };
  const itemIdRef = useRef<number | null>(itemId);
  itemIdRef.current = itemId;

  const setUrl = useCallback(
    (changes: {
      status?: FeedbackStatusFilter;
      category?: FeedbackCategory | null;
      surface?: string | null;
      item?: number | null;
      page?: number;
    }) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          const put = (key: string, value: string | null, dflt: string | null = null) => {
            if (value === null || value === dflt) next.delete(key);
            else next.set(key, value);
          };
          if (changes.status !== undefined) put('status', changes.status, 'active');
          if (changes.category !== undefined) put('category', changes.category);
          if (changes.surface !== undefined) put('surface', changes.surface);
          if (changes.item !== undefined) put('item', changes.item === null ? null : String(changes.item));
          if (changes.page !== undefined) put('page', String(changes.page), '1');
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  /** Loads the list; resolves to null if a newer request superseded it or it failed. */
  const loadList = useCallback(async (f: Filters): Promise<FeedbackList | null> => {
    const id = ++listReq.current;
    setListLoading(true);
    setListError(null);
    try {
      const res = await adminApi.feedback({
        status: f.status,
        category: f.category ?? undefined,
        surface: f.surface ?? undefined,
        page: f.page,
      });
      if (id !== listReq.current) return null;
      setList(res);
      return res;
    } catch (err) {
      if (id === listReq.current) setListError(apiErrorMessage(err, 'Could not load feedback.'));
      return null;
    } finally {
      if (id === listReq.current) setListLoading(false);
    }
  }, []);

  const reloadList = useCallback(() => loadList(filtersRef.current), [loadList]);

  const loadDetail = useCallback(async (id: number) => {
    const req = ++detailReq.current;
    setDetailError(null);
    try {
      const res = await adminApi.feedbackItem(id);
      if (req === detailReq.current && itemIdRef.current === id) setDetail(res);
    } catch (err) {
      if (req !== detailReq.current || itemIdRef.current !== id) return;
      setDetail(null);
      setDetailError(
        err instanceof ApiError && err.status === 404
          ? 'This feedback no longer exists.'
          : apiErrorMessage(err, 'Could not load this feedback.'),
      );
    }
  }, []);

  useEffect(() => {
    setChecked(new Set());
    setBulkError(null);
    void loadList({ status, category, surface, page });
  }, [status, category, surface, page, loadList]);

  useEffect(() => {
    setActionError(null);
    if (itemId === null) {
      ++detailReq.current;
      setDetail(null);
      setDetailError(null);
      return;
    }
    setDetail((d) => (d && d.id === itemId ? d : null));
    void loadDetail(itemId);
  }, [itemId, loadDetail]);

  // After any reload: clamp the page to the last page and drop checked ids no longer listed.
  useEffect(() => {
    if (!list || listLoading) return;
    const maxPage = Math.max(1, Math.ceil(list.total / PAGE_SIZE));
    if (page > maxPage) setUrl({ page: maxPage });
    const present = new Set(list.data.map((r) => r.id));
    setChecked((prev) => {
      if ([...prev].every((id) => present.has(id))) return prev;
      return new Set([...prev].filter((id) => present.has(id)));
    });
  }, [list, listLoading, page, setUrl]);

  // Scroll the list column (TwoPanel's scroll container) to the top on page change.
  const listRootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const scroller = listRootRef.current?.parentElement;
    if (scroller) scroller.scrollTop = 0;
  }, [page]);

  function changeFilter(changes: { status?: FeedbackStatusFilter; category?: FeedbackCategory | null; surface?: string | null }) {
    setUrl({ ...changes, page: 1 });
  }

  function toggleChecked(id: number) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function changeStatus(target: 'reviewed' | 'closed') {
    if (!detail || busy) return;
    const id = detail.id;
    setBusy(true);
    setActionError(null);
    try {
      const res = await adminApi.setFeedbackStatus(id, target);
      if (itemIdRef.current === id) {
        setDetail((d) => (d && d.id === id ? { ...d, status: res.status, updatedAt: res.updatedAt } : d));
      }
    } catch (err) {
      if (itemIdRef.current === id) {
        setActionError(
          err instanceof ApiError && err.status === 409
            ? 'This feedback was already changed. Showing the latest status.'
            : apiErrorMessage(err, 'Could not update this feedback.'),
        );
      }
      await Promise.all([reloadList(), itemIdRef.current === id ? loadDetail(id) : Promise.resolve()]);
      setBusy(false);
      return;
    }
    await reloadList();
    setBusy(false);
  }

  async function bulkChange(target: 'reviewed' | 'closed') {
    const ids = [...checked];
    if (ids.length === 0 || bulkBusy) return;
    setBulkBusy(true);
    setBulkError(null);
    try {
      await adminApi.bulkFeedbackStatus(ids, target);
    } catch (err) {
      setBulkError(apiErrorMessage(err, 'Could not update the selected feedback.'));
      setBulkBusy(false);
      return;
    }
    setChecked(new Set());
    const open = itemIdRef.current;
    await Promise.all([reloadList(), open !== null && ids.includes(open) ? loadDetail(open) : Promise.resolve()]);
    setBulkBusy(false);
  }

  function onDetailKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTextField(e.target)) return;
    if (!detail || detail.id !== itemId || busy) return;
    const key = e.key.toLowerCase();
    if (key === 'r') {
      e.preventDefault();
      if (detail.status === 'new') void changeStatus('reviewed');
    } else if (key === 'e') {
      e.preventDefault();
      if (detail.status !== 'closed') void changeStatus('closed');
    }
  }

  // ── List panel ──────────────────────────────────────────────────────────────

  const rows = list?.data ?? [];
  const isDefaultView = status === 'active' && category === null && surface === null;
  const surfaces = list?.surfaces ?? [];
  const surfaceOptions = surface && !surfaces.includes(surface) ? [surface, ...surfaces] : surfaces;

  const showNoNew = isDefaultView && !!list && !listLoading && !listError && list.counts.new === 0;
  const noNewNotice = showNoNew ? (
    <p style={{ margin: 0, padding: 'var(--sp-4)', color: 'var(--c-text-3)' }}>
      No new feedback.{' '}
      <button
        type="button"
        onClick={() => changeFilter({ status: 'everything' })}
        style={{
          background: 'none',
          border: 'none',
          padding: 0,
          font: 'inherit',
          color: 'var(--c-primary)',
          textDecoration: 'underline',
          cursor: 'pointer',
        }}
      >
        Show everything
      </button>
    </p>
  ) : null;

  let emptyContent: ReactNode = null;
  if (rows.length === 0) {
    if (listLoading) emptyContent = 'Loading…';
    else if (listError || showNoNew) emptyContent = null;
    else emptyContent = 'No feedback matches these filters.';
  }

  const listPanel = (
    <div ref={listRootRef}>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 'var(--sp-2)',
          padding: 'var(--sp-3)',
          borderBottom: '1px solid var(--c-border)',
        }}
      >
        <label style={labelStyle}>
          Status
          <select
            value={status}
            onChange={(e) => changeFilter({ status: e.target.value as FeedbackStatusFilter })}
            style={controlStyle}
          >
            {STATUS_FILTERS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label style={labelStyle}>
          Category
          <select
            value={category ?? ''}
            onChange={(e) => changeFilter({ category: (e.target.value || null) as FeedbackCategory | null })}
            style={controlStyle}
          >
            <option value="">All</option>
            {CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label style={labelStyle}>
          Surface
          <select
            value={surface ?? ''}
            onChange={(e) => changeFilter({ surface: e.target.value || null })}
            style={{ ...controlStyle, maxWidth: 140 }}
          >
            <option value="">All</option>
            {surfaceOptions.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        {list && (
          <p style={{ margin: 0, width: '100%', fontSize: 12, color: 'var(--c-text-2)' }}>
            New {list.counts.new} · Read {list.counts.reviewed} · Archived {list.counts.closed}
          </p>
        )}
      </div>

      {checked.size > 0 && (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 'var(--sp-2)',
            padding: 'var(--sp-2) var(--sp-3)',
            borderBottom: '1px solid var(--c-border)',
            background: 'var(--c-surface-raised)',
          }}
        >
          <span style={{ fontSize: 14, fontWeight: 600 }}>{checked.size} selected</span>
          <Button disabled={bulkBusy} onClick={() => void bulkChange('reviewed')}>
            Mark selected as read
          </Button>
          <Button disabled={bulkBusy} onClick={() => void bulkChange('closed')}>
            Archive selected
          </Button>
          {bulkError && (
            <p role="alert" style={{ margin: 0, width: '100%', fontSize: 13, color: 'var(--c-danger)' }}>
              {bulkError}
            </p>
          )}
        </div>
      )}

      {listError && (
        <p role="alert" style={{ margin: 0, padding: 'var(--sp-3) var(--sp-4)', color: 'var(--c-danger)' }}>
          {listError}
        </p>
      )}

      {noNewNotice}

      {rows.length === 0 ? (
        emptyContent !== null && <p style={{ margin: 0, padding: 'var(--sp-4)', color: 'var(--c-text-3)' }}>{emptyContent}</p>
      ) : (
        <ul
          aria-label="Feedback"
          aria-busy={listLoading || undefined}
          style={{ listStyle: 'none', margin: 0, padding: 0, opacity: listLoading ? 0.6 : 1 }}
        >
          {rows.map((row) => {
            const selected = row.id === itemId;
            return (
              <li
                key={row.id}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  background: selected ? 'var(--c-surface-raised)' : 'transparent',
                  borderLeft: `3px solid ${selected ? 'var(--c-primary)' : 'transparent'}`,
                  borderBottom: '1px solid var(--c-border-subtle)',
                }}
              >
                <input
                  type="checkbox"
                  aria-label={`Select feedback ${row.id}`}
                  checked={checked.has(row.id)}
                  onChange={() => toggleChecked(row.id)}
                  style={{ margin: 'var(--sp-3) 0 0 var(--sp-3)', flexShrink: 0, cursor: 'pointer' }}
                />
                <button
                  type="button"
                  onClick={() => setUrl({ item: row.id })}
                  aria-current={selected ? 'true' : undefined}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 'var(--sp-1)',
                    padding: 'var(--sp-2) var(--sp-3)',
                    background: 'none',
                    border: 'none',
                    textAlign: 'left',
                    fontFamily: 'var(--font-ui)',
                    fontSize: 14,
                    color: 'var(--c-text)',
                    cursor: 'pointer',
                  }}
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)', width: '100%' }}>
                    <CategoryChip category={row.category} />
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        overflowWrap: 'anywhere',
                        fontWeight: row.status === 'new' ? 600 : 400,
                      }}
                    >
                      {truncatePreview(row.preview)}
                    </span>
                    <span style={{ width: 14, flexShrink: 0, display: 'inline-flex', justifyContent: 'center' }}>
                      <StatusDot kind={STATUS_DOT[row.status]} label={STATUS_LABEL[row.status]} />
                    </span>
                  </span>
                  <span style={{ display: 'flex', flexWrap: 'wrap', gap: '0 var(--sp-2)', fontSize: 12, color: 'var(--c-text-3)' }}>
                    <span>{row.sourceSurface || EMPTY}</span>
                    <span>{formatRelative(row.createdAt)}</span>
                    <span>{row.userLabel || 'Guest'}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {list && list.total > PAGE_SIZE && (
        <div style={{ padding: 'var(--sp-3)' }}>
          <Pager page={page} pageSize={PAGE_SIZE} total={list.total} onPageChange={(p) => setUrl({ page: p })} />
        </div>
      )}
    </div>
  );

  // ── Detail panel ────────────────────────────────────────────────────────────

  let detailContent: ReactNode;
  if (itemId === null) {
    detailContent = <p style={subdued}>Select feedback to read it.</p>;
  } else if (detailError) {
    detailContent = (
      <p role="alert" style={{ ...subdued, color: 'var(--c-danger)' }}>
        {detailError}
      </p>
    );
  } else if (!detail || detail.id !== itemId) {
    detailContent = <p style={subdued}>Loading…</p>;
  } else {
    detailContent = (
      <FeedbackItem
        detail={detail}
        busy={busy}
        actionError={actionError}
        onMarkRead={() => void changeStatus('reviewed')}
        onArchive={() => void changeStatus('closed')}
        onRestore={() => void changeStatus('reviewed')}
      />
    );
  }

  const detailPanel = (
    <div
      tabIndex={0}
      role="region"
      aria-label="Feedback detail"
      onKeyDown={onDetailKeyDown}
      style={{ minHeight: '100%', outline: 'none' }}
      className="focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--c-primary)]"
    >
      {detailContent}
    </div>
  );

  return (
    <div style={{ height: '100%', minHeight: 0 }}>
      <TwoPanel list={listPanel} detail={detailPanel} />
    </div>
  );
}

// ── Detail view ───────────────────────────────────────────────────────────────

interface FeedbackItemProps {
  detail: FeedbackDetail;
  busy: boolean;
  actionError: string | null;
  onMarkRead: () => void;
  onArchive: () => void;
  onRestore: () => void;
}

function FeedbackItem({ detail, busy, actionError, onMarkRead, onArchive, onRestore }: FeedbackItemProps) {
  const name = detail.user?.displayName?.trim();
  const who = detail.user ? (name ? `${name} · ${detail.user.email}` : detail.user.email) : 'Guest (not logged in)';

  const meta: Array<[string, ReactNode]> = [
    ['From', who],
    ['Surface', detail.sourceSurface || EMPTY],
    ['Sent', formatDateTime(detail.createdAt)],
    ['App version', detail.appVersion || EMPTY],
  ];

  return (
    <div style={{ padding: 'var(--sp-5)', display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)', maxWidth: 760 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--sp-2) var(--sp-3)' }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, lineHeight: '28px' }}>Feedback #{detail.id}</h2>
        <CategoryChip category={detail.category} />
        <span data-testid="feedback-status">
          <Chip background={STATUS_BADGE_BG[detail.status]}>{STATUS_LABEL[detail.status]}</Chip>
        </span>
      </div>

      <dl
        style={{
          display: 'grid',
          gridTemplateColumns: 'max-content 1fr',
          gap: 'var(--sp-1) var(--sp-4)',
          margin: 0,
          fontSize: 14,
        }}
      >
        {meta.map(([label, value]) => (
          <div key={label} style={{ display: 'contents' }}>
            <dt style={{ color: 'var(--c-text-2)' }}>{label}</dt>
            <dd style={{ margin: 0, color: 'var(--c-text)', overflowWrap: 'anywhere' }}>{value}</dd>
          </div>
        ))}
      </dl>

      <div
        style={{
          padding: 'var(--sp-3)',
          border: '1px solid var(--c-border)',
          borderRadius: 'var(--r-md)',
          background: 'var(--c-surface)',
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
          lineHeight: 1.5,
        }}
      >
        {detail.message}
      </div>

      <div>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--sp-2)' }}>
          {detail.status === 'new' && (
            <Button variant="primary" disabled={busy} onClick={onMarkRead}>
              Mark as read
            </Button>
          )}
          {detail.status !== 'closed' && (
            <Button disabled={busy} onClick={onArchive}>
              Archive
            </Button>
          )}
          {detail.status === 'closed' && (
            <Button disabled={busy} onClick={onRestore}>
              Restore
            </Button>
          )}
          <span style={{ marginLeft: 'var(--sp-2)', fontSize: 12, color: 'var(--c-text-3)' }}>R: read · E: archive</span>
        </div>
        {actionError && (
          <p role="alert" style={{ margin: 'var(--sp-2) 0 0', fontSize: 13, color: 'var(--c-danger)' }}>
            {actionError}
          </p>
        )}
      </div>
    </div>
  );
}
