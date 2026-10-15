import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ApiError } from '../../lib/api';
import {
  adminApi,
  apiErrorMessage,
  type ModerationDetail,
  type ModerationList,
  type ModerationRow,
  type ModerationStatus,
  type ModerationTab,
} from '../../lib/adminApi';
import Button from '../../components/admin/Button';
import Chip from '../../components/admin/Chip';
import ConfirmDialog from '../../components/admin/ConfirmDialog';
import FieldList from '../../components/admin/FieldList';
import Pager from '../../components/admin/Pager';
import StatusDot, { type StatusDotKind } from '../../components/admin/StatusDot';
import TwoPanel from '../../components/admin/TwoPanel';
import { EMPTY, formatDateTime, formatRelative } from '../../components/admin/format';

const PAGE_SIZE = 50;
const NOTE_MAX = 2000;
const ALREADY_RESOLVED = 'This item was already resolved.';

const TABS: Array<{ key: ModerationTab; label: string; empty: string }> = [
  { key: 'all', label: 'All', empty: 'Nothing to review.' },
  { key: 'corrections', label: 'Corrections', empty: 'No corrections to review.' },
  { key: 'new_seeds', label: 'New seeds', empty: 'No new seed submissions to review.' },
  { key: 'resolved', label: 'Resolved', empty: 'No resolved items.' },
];

function parseTab(value: string | null): ModerationTab {
  return TABS.some((t) => t.key === value) ? (value as ModerationTab) : 'all';
}

function parseId(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  return Number(value);
}

function countFor(list: ModerationList | null, tab: ModerationTab): number | null {
  if (!list) return null;
  switch (tab) {
    case 'all':
      return list.counts.all;
    case 'corrections':
      return list.counts.corrections;
    case 'new_seeds':
      return list.counts.newSeeds;
    case 'resolved':
      return list.counts.resolved;
  }
}

const STATUS_LABEL: Record<ModerationStatus, string> = {
  new: 'New',
  under_review: 'Under review',
  approved: 'Approved',
  rejected: 'Rejected',
};

const STATUS_DOT: Record<ModerationStatus, { kind: StatusDotKind; color: string }> = {
  new: { kind: 'filled', color: 'var(--c-primary)' },
  under_review: { kind: 'half', color: 'var(--c-warning)' },
  approved: { kind: 'check', color: 'var(--c-success)' },
  rejected: { kind: 'check', color: 'var(--c-text-3)' },
};

const STATUS_BADGE_BG: Record<ModerationStatus, string> = {
  new: 'var(--c-info-bg)',
  under_review: 'var(--c-warning-bg)',
  approved: 'var(--c-success-bg)',
  rejected: 'var(--c-danger-bg)',
};

function isUnresolved(status: ModerationStatus): boolean {
  return status === 'new' || status === 'under_review';
}

function TypeChip({ type }: { type: ModerationRow['type'] }) {
  return type === 'correction' ? (
    <Chip background="var(--c-warning-bg)">Correction</Chip>
  ) : (
    <Chip background="var(--c-success-bg)">New seed</Chip>
  );
}

function submitterLabel(detail: ModerationDetail): string {
  if (!detail.submitter) return 'Anonymous';
  return detail.submitter.displayName || detail.submitter.email;
}

const subdued: CSSProperties = { margin: 0, padding: 'var(--sp-5)', color: 'var(--c-text-3)' };
const sectionHeading: CSSProperties = { margin: '0 0 var(--sp-2)', fontSize: 14, fontWeight: 600, color: 'var(--c-text)' };

export default function ModerationPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = parseTab(searchParams.get('tab'));
  const itemId = parseId(searchParams.get('item'));

  const resolvedPage = tab === 'resolved' ? Math.max(1, parseId(searchParams.get('page')) ?? 1) : 1;

  const [list, setList] = useState<ModerationList | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [detail, setDetail] = useState<ModerationDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [nothingLeft, setNothingLeft] = useState(false);

  const [confirmAction, setConfirmAction] = useState<'approve' | 'reject' | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const listReq = useRef(0);
  const detailReq = useRef(0);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // The currently selected item, readable from async callbacks after awaits.
  const itemIdRef = useRef(itemId);
  itemIdRef.current = itemId;
  // Heading (or the empty-state text) in the detail panel; receives focus after approve/reject.
  const detailFocusRef = useRef<HTMLElement | null>(null);
  // After approve/reject: the item whose heading should get focus once shown ('none' = the empty state).
  const pendingFocus = useRef<number | 'none' | null>(null);

  const setUrl = useCallback(
    (changes: { tab?: ModerationTab; item?: number | null; page?: number | null }) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (changes.tab !== undefined) {
            if (changes.tab === 'all') next.delete('tab');
            else next.set('tab', changes.tab);
          }
          if (changes.item !== undefined) {
            if (changes.item === null) next.delete('item');
            else next.set('item', String(changes.item));
          }
          if (changes.page !== undefined) {
            if (changes.page === null || changes.page <= 1) next.delete('page');
            else next.set('page', String(changes.page));
          }
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  /** Loads the list for a tab; resolves to null if a newer request superseded it or it failed. */
  const loadList = useCallback(async (forTab: ModerationTab, page: number): Promise<ModerationList | null> => {
    const id = ++listReq.current;
    setListLoading(true);
    setListError(null);
    try {
      const res = await adminApi.moderation(forTab, page);
      if (id !== listReq.current) return null;
      setList(res);
      return res;
    } catch (err) {
      if (id === listReq.current) setListError(apiErrorMessage(err, 'Could not load the moderation queue.'));
      return null;
    } finally {
      if (id === listReq.current) setListLoading(false);
    }
  }, []);

  /** Loads an item's detail, but only while that item is still the selected one. */
  const loadDetail = useCallback(async (id: number) => {
    if (itemIdRef.current !== id) return;
    const req = ++detailReq.current;
    setDetailError(null);
    try {
      const res = await adminApi.moderationItem(id);
      if (req === detailReq.current && itemIdRef.current === id) setDetail(res);
    } catch (err) {
      if (req !== detailReq.current || itemIdRef.current !== id) return;
      setDetail(null);
      setDetailError(
        err instanceof ApiError && err.status === 404 ? 'This item no longer exists.' : apiErrorMessage(err, 'Could not load this item.'),
      );
    }
  }, []);

  useEffect(() => {
    void loadList(tab, resolvedPage);
  }, [tab, resolvedPage, loadList]);

  useEffect(() => {
    setConfirmAction(null);
    setActionError(null);
    if (itemId === null) {
      ++detailReq.current;
      setDetail(null);
      setDetailError(null);
      return;
    }
    setNothingLeft(false);
    setDetail((d) => (d && d.id === itemId ? d : null));
    void loadDetail(itemId);
  }, [itemId, loadDetail]);

  // Move focus to the detail heading once the item chosen after approve/reject is on screen.
  useEffect(() => {
    const target = pendingFocus.current;
    if (target === null || !detailFocusRef.current) return;
    if (target === 'none' ? itemId === null : detail?.id === target && itemId === target) {
      pendingFocus.current = null;
      detailFocusRef.current.focus();
    }
  });

  function selectTab(next: ModerationTab) {
    if (next === tab) return;
    setNotice(null);
    setNothingLeft(false);
    setUrl({ tab: next, page: null });
  }

  function setResolvedPage(page: number) {
    setUrl({ page });
  }

  function onTabKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number | null = null;
    if (e.key === 'ArrowRight') next = (index + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = TABS.length - 1;
    if (next === null) return;
    e.preventDefault();
    tabRefs.current[next]?.focus();
    selectTab(TABS[next].key);
  }

  function selectItem(id: number) {
    setNotice(null);
    setNothingLeft(false);
    pendingFocus.current = null;
    setUrl({ item: id });
  }

  async function runAction(action: 'approve' | 'reject' | 'defer') {
    if (!detail) return;
    const id = detail.id;
    const before = list && list.tab === tab ? list.data : [];
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      try {
        await adminApi.moderate(id, action, action === 'defer' ? undefined : note.trim() || undefined);
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          setConfirmAction(null);
          if (itemIdRef.current === id) setNotice(ALREADY_RESOLVED);
          await Promise.all([loadList(tab, resolvedPage), loadDetail(id)]);
          return;
        }
        if (itemIdRef.current === id) setActionError(apiErrorMessage(err, 'Could not update this item.'));
        return;
      }

      setConfirmAction(null);
      setNote('');

      if (action === 'defer') {
        await Promise.all([loadList(tab, resolvedPage), loadDetail(id)]);
        return;
      }

      const refreshed = await loadList(tab, resolvedPage);
      if (!refreshed) {
        // Refresh failed or was superseded: keep the item open and show its resolved state.
        await loadDetail(id);
        return;
      }
      if (itemIdRef.current !== id) return; // the admin has already moved on to another item

      const remaining = refreshed.data;
      const stillThere = (row: ModerationRow) =>
        row.id !== id && remaining.some((r) => r.id === row.id && isUnresolved(r.status));
      const index = before.findIndex((r) => r.id === id);
      let nextId: number | null = null;
      if (index >= 0) {
        nextId = before.slice(index + 1).find(stillThere)?.id ?? before.slice(0, index).reverse().find(stillThere)?.id ?? null;
      } else {
        nextId = remaining.find((r) => isUnresolved(r.status))?.id ?? null;
      }
      if (nextId !== null) {
        pendingFocus.current = nextId;
        setUrl({ item: nextId });
      } else {
        pendingFocus.current = 'none';
        setNothingLeft(true);
        setUrl({ item: null });
      }
    } finally {
      setBusy(false);
    }
  }

  function openConfirm(action: 'approve' | 'reject') {
    setNote('');
    setActionError(null);
    setConfirmAction(action);
  }

  // ── List panel ──────────────────────────────────────────────────────────────

  const tabMeta = TABS.find((t) => t.key === tab)!;
  const rows = list && list.tab === tab ? list.data : [];

  const listPanel = (
    <div role="tabpanel" id="moderation-list" aria-labelledby={`moderation-tab-${tab}`}>
      {listError && (
        <p role="alert" style={{ margin: 0, padding: 'var(--sp-3) var(--sp-4)', color: 'var(--c-danger)' }}>
          {listError}
        </p>
      )}
      {rows.length === 0 ? (
        <p style={{ margin: 0, padding: 'var(--sp-4)', color: 'var(--c-text-3)' }}>
          {listLoading ? 'Loading…' : listError ? '' : tabMeta.empty}
        </p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, opacity: listLoading ? 0.6 : 1 }} aria-busy={listLoading || undefined}>
          {rows.map((row) => {
            const selected = row.id === itemId;
            const dot = STATUS_DOT[row.status];
            return (
              <li key={row.id}>
                <button
                  type="button"
                  onClick={() => selectItem(row.id)}
                  aria-current={selected ? 'true' : undefined}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--sp-2)',
                    width: '100%',
                    minHeight: 36,
                    padding: 'var(--sp-2) var(--sp-3)',
                    boxSizing: 'border-box',
                    background: selected ? 'var(--c-surface-raised)' : 'transparent',
                    border: 'none',
                    borderLeft: `3px solid ${selected ? 'var(--c-primary)' : 'transparent'}`,
                    borderBottom: '1px solid var(--c-border-subtle)',
                    textAlign: 'left',
                    fontFamily: 'var(--font-ui)',
                    fontSize: 14,
                    color: 'var(--c-text)',
                    cursor: 'pointer',
                  }}
                >
                  <span style={{ width: 14, flexShrink: 0, display: 'inline-flex', justifyContent: 'center' }}>
                    <StatusDot kind={dot.kind} color={dot.color} label={STATUS_LABEL[row.status]} />
                  </span>
                  <TypeChip type={row.type} />
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      fontWeight: row.status === 'new' ? 600 : 400,
                    }}
                  >
                    {row.seedName || 'Unknown seed'}
                  </span>
                  <span style={{ flexShrink: 0, fontSize: 12, color: 'var(--c-text-3)' }}>
                    {formatRelative(tab === 'resolved' ? row.resolvedAt ?? row.createdAt : row.createdAt)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {tab === 'resolved' && list && list.tab === 'resolved' && list.total > PAGE_SIZE && (
        <div style={{ padding: 'var(--sp-3)' }}>
          <Pager page={resolvedPage} pageSize={PAGE_SIZE} total={list.total} onPageChange={setResolvedPage} />
        </div>
      )}
    </div>
  );

  // ── Detail panel ────────────────────────────────────────────────────────────

  let detailPanel: ReactNode;
  if (itemId === null) {
    detailPanel = (
      <p
        ref={(el) => {
          detailFocusRef.current = el;
        }}
        tabIndex={-1}
        style={{ ...subdued, outline: 'none' }}
      >
        {nothingLeft ? 'Nothing left to review.' : 'Select an item to review.'}
      </p>
    );
  } else if (detailError) {
    detailPanel = (
      <p role="alert" style={{ ...subdued, color: 'var(--c-danger)' }}>
        {detailError}
      </p>
    );
  } else if (!detail || detail.id !== itemId) {
    detailPanel = <p style={subdued}>Loading…</p>;
  } else {
    detailPanel = (
      <ItemDetail
        detail={detail}
        headingRef={(el) => {
          detailFocusRef.current = el;
        }}
        notice={notice}
        busy={busy}
        actionError={confirmAction ? null : actionError}
        onApprove={() => openConfirm('approve')}
        onReject={() => openConfirm('reject')}
        onDefer={() => void runAction('defer')}
      />
    );
  }

  const isCorrection = detail?.type === 'correction';
  const noun = isCorrection ? 'correction' : 'submission';

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div
        role="tablist"
        aria-label="Moderation queue"
        style={{
          flexShrink: 0,
          display: 'flex',
          gap: 'var(--sp-1)',
          padding: '0 var(--sp-4)',
          borderBottom: '1px solid var(--c-border)',
          background: 'var(--c-surface)',
        }}
      >
        {TABS.map((t, i) => {
          const selected = t.key === tab;
          const count = countFor(list, t.key);
          return (
            <button
              key={t.key}
              ref={(el) => {
                tabRefs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`moderation-tab-${t.key}`}
              aria-selected={selected}
              aria-controls="moderation-list"
              tabIndex={selected ? 0 : -1}
              onClick={() => selectTab(t.key)}
              onKeyDown={(e) => onTabKeyDown(e, i)}
              style={{
                height: 40,
                padding: '0 var(--sp-3)',
                background: 'none',
                border: 'none',
                borderBottom: `2px solid ${selected ? 'var(--c-primary)' : 'transparent'}`,
                marginBottom: -1,
                fontFamily: 'var(--font-ui)',
                fontSize: 14,
                fontWeight: selected ? 600 : 400,
                color: selected ? 'var(--c-text)' : 'var(--c-text-2)',
                cursor: 'pointer',
              }}
            >
              {count === null ? t.label : `${t.label} (${count})`}
            </button>
          );
        })}
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <TwoPanel list={listPanel} detail={detailPanel} />
      </div>

      <ConfirmDialog
        open={confirmAction !== null}
        title={confirmAction === 'approve' ? `Approve this ${noun}?` : `Reject this ${noun}?`}
        message={
          confirmAction === 'approve'
            ? `The ${noun} will be marked as approved.`
            : `The ${noun} will be marked as rejected.`
        }
        confirmLabel="Confirm"
        variant={confirmAction === 'reject' ? 'danger' : 'primary'}
        busy={busy}
        error={actionError}
        onCancel={() => {
          if (busy) return;
          setConfirmAction(null);
          setActionError(null);
        }}
        onConfirm={() => (confirmAction ? runAction(confirmAction) : undefined)}
      >
        <label style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-1)', fontSize: 13, color: 'var(--c-text-2)' }}>
          {confirmAction === 'approve' ? 'Note for the record (optional)' : 'Reason for rejection (optional, not shown to user)'}
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={NOTE_MAX}
            rows={4}
            style={{
              boxSizing: 'border-box',
              width: '100%',
              padding: 'var(--sp-2)',
              border: '1px solid var(--c-border)',
              borderRadius: 'var(--r-md)',
              background: 'var(--c-surface)',
              color: 'var(--c-text)',
              fontFamily: 'var(--font-ui)',
              fontSize: 14,
              resize: 'vertical',
            }}
          />
        </label>
        <div style={{ marginTop: 'var(--sp-1)', fontSize: 12, color: 'var(--c-text-3)', textAlign: 'right' }}>
          {note.length} / {NOTE_MAX}
        </div>
      </ConfirmDialog>
    </div>
  );
}

// ── Detail view ───────────────────────────────────────────────────────────────

interface ItemDetailProps {
  detail: ModerationDetail;
  headingRef: (el: HTMLHeadingElement | null) => void;
  notice: string | null;
  busy: boolean;
  actionError: string | null;
  onApprove: () => void;
  onReject: () => void;
  onDefer: () => void;
}

function seedLink(name: string, italic = false) {
  return (
    <Link
      to={`/admin/seeds?q=${encodeURIComponent(name)}`}
      style={{ color: 'var(--c-primary)', fontStyle: italic ? 'italic' : undefined }}
    >
      {name}
    </Link>
  );
}

function ItemDetail({ detail, headingRef, notice, busy, actionError, onApprove, onReject, onDefer }: ItemDetailProps) {
  const isCorrection = detail.type === 'correction';
  const unresolved = isUnresolved(detail.status);
  const content = detail.content ?? {};

  const contentSeedName = typeof content.seedName === 'string' ? content.seedName : null;
  const commonName = detail.seed?.commonName || detail.seedName || contentSeedName;
  const botanicalName = detail.seed?.scientificName ?? null;
  const correctionText = typeof content.correctionText === 'string' ? content.correctionText : null;

  const entries = Object.entries(content);
  // Forward-compatible: current new_seed snapshots carry no companion keys, but any
  // future /companion/i fields are kept out of the main list and flagged for review.
  const mainFields = entries.filter(([k]) => !/companion/i.test(k));
  const companionFields = entries.filter(([k]) => /companion/i.test(k));

  return (
    <div style={{ padding: 'var(--sp-5)', display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)', maxWidth: 760 }}>
      <div>
        <h2 ref={headingRef} tabIndex={-1} style={{ margin: 0, fontSize: 18, fontWeight: 600, lineHeight: '28px', outline: 'none' }}>
          {isCorrection ? 'Seed correction' : 'New seed submission'}
        </h2>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 'var(--sp-2) var(--sp-3)',
            marginTop: 'var(--sp-1)',
            color: 'var(--c-text-2)',
          }}
        >
          <span>{formatDateTime(detail.createdAt)}</span>
          <span>{submitterLabel(detail)}</span>
          <Chip background={STATUS_BADGE_BG[detail.status]}>{STATUS_LABEL[detail.status]}</Chip>
        </div>
      </div>

      {notice && (
        <p role="status" style={{ margin: 0, padding: 'var(--sp-2) var(--sp-3)', background: 'var(--c-warning-bg)', borderRadius: 'var(--r-md)' }}>
          {notice}
        </p>
      )}

      {isCorrection ? (
        <>
          <section>
            <h3 style={sectionHeading}>Seed</h3>
            {commonName || botanicalName ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--sp-2) var(--sp-3)' }}>
                {commonName && seedLink(commonName)}
                {botanicalName && seedLink(botanicalName, true)}
              </div>
            ) : (
              <span style={{ color: 'var(--c-text-3)' }}>Unknown seed</span>
            )}
          </section>
          <section>
            <h3 style={sectionHeading}>Correction</h3>
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
              {correctionText && correctionText.trim() ? correctionText : EMPTY}
            </div>
          </section>
        </>
      ) : (
        <>
          <section>
            <h3 style={sectionHeading}>Submitted fields</h3>
            <FieldList entries={mainFields} />
          </section>
          {companionFields.length > 0 && (
            <section>
              <h3 style={sectionHeading}>Companion notes</h3>
              <p style={{ margin: '0 0 var(--sp-2)', fontSize: 13, color: 'var(--c-text-2)' }}>
                Cambium's companion model may differ — review before adding.
              </p>
              <FieldList entries={companionFields} />
            </section>
          )}
        </>
      )}

      {!unresolved && (
        <section>
          <h3 style={sectionHeading}>Resolution</h3>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--sp-2) var(--sp-3)', color: 'var(--c-text-2)' }}>
            <span style={{ color: 'var(--c-text)', fontWeight: 600 }}>{STATUS_LABEL[detail.status]}</span>
            <span>{formatDateTime(detail.resolvedAt)}</span>
          </div>
          <p style={{ margin: 'var(--sp-2) 0 0', whiteSpace: 'pre-wrap', color: detail.resolutionNote ? 'var(--c-text)' : 'var(--c-text-3)' }}>
            {detail.resolutionNote || 'No note'}
          </p>
        </section>
      )}

      {unresolved && (
        <div>
          <div style={{ display: 'flex', gap: 'var(--sp-2)' }}>
            <Button variant="primary" disabled={busy} onClick={onApprove}>
              Approve
            </Button>
            <Button variant="secondary" disabled={busy} onClick={onReject}>
              Reject
            </Button>
            <Button variant="ghost" disabled={busy} onClick={onDefer}>
              Defer
            </Button>
          </div>
          {actionError && (
            <p role="alert" style={{ margin: 'var(--sp-2) 0 0', fontSize: 13, color: 'var(--c-danger)' }}>
              {actionError}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
