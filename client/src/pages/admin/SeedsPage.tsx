import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  adminApi,
  apiErrorMessage,
  type AdminSeedRow,
  type AdminSeedsPage,
  type SeedSortKey,
  type SeedSource,
  type SeedsSummary,
  type SortDir,
} from '../../lib/adminApi';
import Button from '../../components/admin/Button';
import DataTable, { type DataTableColumn } from '../../components/admin/DataTable';
import Pager from '../../components/admin/Pager';
import SeedDetailModal from '../../components/admin/SeedDetailModal';
import StatCard from '../../components/admin/StatCard';
import { EMPTY, formatDate, formatNumber } from '../../components/admin/format';

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 300;

const SORT_KEYS: SeedSortKey[] = [
  'common_name',
  'scientific_name',
  'plant_family',
  'source',
  'open_corrections',
  'created_at',
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

export default function SeedsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const q = searchParams.get('q') ?? '';

  const [qInput, setQInput] = useState(q);
  const [source, setSource] = useState<SeedSource | ''>('');
  const [hasCorrections, setHasCorrections] = useState(false);
  const [sort, setSort] = useState<{ key: SeedSortKey; dir: SortDir }>({ key: 'common_name', dir: 'asc' });
  const [page, setPage] = useState(1);

  const [summary, setSummary] = useState<SeedsSummary | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [result, setResult] = useState<AdminSeedsPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<AdminSeedRow | null>(null);

  const requestId = useRef(0);
  // The q value this page last wrote to the URL, so external URL changes can be told apart.
  const committedQ = useRef(q);

  // Follow external changes to ?q= (e.g. a link from Moderation while already here).
  useEffect(() => {
    if (q !== committedQ.current) {
      committedQ.current = q;
      setQInput(q);
      setPage(1);
    }
  }, [q]);

  // Debounce the search box into ?q=.
  useEffect(() => {
    const trimmed = qInput.trim();
    if (trimmed === committedQ.current) return;
    const t = window.setTimeout(() => {
      committedQ.current = trimmed;
      setPage(1);
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (trimmed) next.set('q', trimmed);
          else next.delete('q');
          return next;
        },
        { replace: true },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [qInput, setSearchParams]);

  useEffect(() => {
    adminApi
      .seedsSummary()
      .then(setSummary)
      .catch((err: unknown) => setSummaryError(apiErrorMessage(err, 'Could not load seed totals.')));
  }, []);

  useEffect(() => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    adminApi
      .seeds({
        q: q || undefined,
        source: source || undefined,
        hasCorrections: hasCorrections || undefined,
        sort: sort.key,
        dir: sort.dir,
        page,
      })
      .then((res) => {
        if (id !== requestId.current) return;
        setResult(res);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (id !== requestId.current) return;
        setError(apiErrorMessage(err, 'Could not load seeds.'));
        setLoading(false);
      });
  }, [q, source, hasCorrections, sort, page]);

  const columns: Array<DataTableColumn<AdminSeedRow>> = [
    { key: 'common_name', header: 'Common name', sortable: true, render: (r) => r.commonName },
    {
      key: 'scientific_name',
      header: 'Botanical name',
      sortable: true,
      render: (r) => (r.scientificName ? <em>{r.scientificName}</em> : EMPTY),
    },
    { key: 'plant_family', header: 'Family', sortable: true, render: (r) => r.plantFamily ?? EMPTY },
    {
      key: 'source',
      header: 'Source',
      sortable: true,
      width: 120,
      render: (r) => (r.source === 'cambium' ? 'Cambium' : 'Community'),
    },
    {
      key: 'open_corrections',
      header: 'Corrections',
      sortable: true,
      defaultDir: 'desc',
      align: 'right',
      width: 120,
      render: (r) => formatNumber(r.openCorrections),
    },
    { key: 'created_at', header: 'Added', sortable: true, defaultDir: 'desc', width: 130, render: (r) => formatDate(r.createdAt) },
    {
      key: 'view',
      header: 'View',
      width: 90,
      align: 'right',
      render: (r) => (
        <Button
          variant="ghost"
          onClick={() => setViewing(r)}
          aria-label={`View ${r.commonName}`}
          style={{ height: 28 }}
        >
          View
        </Button>
      ),
    },
  ];

  const pending = summary?.pendingModeration ?? 0;

  return (
    <div style={{ padding: 'var(--sp-5)', display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 'var(--sp-3)' }}>
        <StatCard label="Total seeds" value={summary ? formatNumber(summary.totalSeeds) : EMPTY} />
        <StatCard label="Community seeds" value={summary ? formatNumber(summary.communitySeeds) : EMPTY} />
        <StatCard
          label="Pending moderation"
          value={summary ? formatNumber(pending) : EMPTY}
          tone={pending > 0 ? 'attention' : undefined}
          to={pending > 0 ? '/admin/moderation' : undefined}
        />
        <StatCard label="Added this month" value={summary ? formatNumber(summary.addedThisMonth) : EMPTY} />
      </div>
      {summaryError && (
        <p role="alert" style={{ margin: 0, color: 'var(--c-danger)' }}>
          {summaryError}
        </p>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 'var(--sp-3)' }}>
        <label style={labelStyle}>
          Search
          <input
            type="search"
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            placeholder="Common or botanical name"
            style={{ ...controlStyle, width: 280 }}
          />
        </label>
        <label style={labelStyle}>
          Source
          <select
            value={source}
            onChange={(e) => {
              setSource(e.target.value as SeedSource | '');
              setPage(1);
            }}
            style={controlStyle}
          >
            <option value="">All</option>
            <option value="cambium">Cambium</option>
            <option value="community">Community</option>
          </select>
        </label>
        <label style={labelStyle}>
          Corrections
          <select
            value={hasCorrections ? 'open' : ''}
            onChange={(e) => {
              setHasCorrections(e.target.value === 'open');
              setPage(1);
            }}
            style={controlStyle}
          >
            <option value="">All</option>
            <option value="open">Has open corrections</option>
          </select>
        </label>
        <span style={{ marginLeft: 'auto', color: 'var(--c-text-2)', alignSelf: 'center' }}>
          {result && !error ? `${formatNumber(result.total)} seeds` : ''}
        </span>
      </div>

      {error && (
        <p role="alert" style={{ margin: 0, color: 'var(--c-danger)' }}>
          {error}
        </p>
      )}

      <div
        style={{
          background: 'var(--c-surface)',
          border: '1px solid var(--c-border)',
          borderRadius: 'var(--r-md)',
          overflow: 'hidden',
        }}
      >
        <DataTable
          columns={columns}
          rows={error ? [] : result?.data ?? []}
          rowKey={(r) => r.id}
          sort={sort}
          onSortChange={(key, dir) => {
            if (!SORT_KEYS.includes(key as SeedSortKey)) return;
            setSort({ key: key as SeedSortKey, dir });
            setPage(1);
          }}
          emptyText={error ? 'Seeds could not be loaded.' : 'No seeds match these filters.'}
          loading={loading}
        />
      </div>

      {!error && result && result.total > 0 && (
        <Pager page={page} pageSize={PAGE_SIZE} total={result.total} onPageChange={setPage} />
      )}

      {viewing && (
        <SeedDetailModal seedId={viewing.id} fallbackName={viewing.commonName} onClose={() => setViewing(null)} />
      )}
    </div>
  );
}
