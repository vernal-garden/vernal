import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useGardenList } from '../hooks/useGardenList';
import { formatQuantity, harvestQuery, parseSeedParam, seedParamOf } from '../hooks/useHarvests';
import { get } from '../lib/api';
import { MONTH_SHORT, parseDay, todayPacific } from '../lib/guideDates';
import { filterSearch, type HarvestFilters } from '../lib/harvestFilters';
import { track } from '../lib/track';
import type { HarvestEntry, HarvestListResponse, SeedParam } from '../types/harvest';
import { primaryButtonStyle, spinnerStyle, textButtonStyle } from '../components/harvest/formStyles';

// The API's largest page size (MAX_LIMIT in src/routes/harvests.ts).
const PAGE_LIMIT = 100;
const MAX_ENTRIES = 2000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const PRINT_CSS = `
@page { margin: 16mm 14mm; }
@media print {
  html, body { background: var(--c-surface) !important; }
  .harvest-print-controls { display: none !important; }
  /* Backstop: only this page prints, never anything else mounted beside it. */
  body > :not(#root), #root > :not(.harvest-print-page) { display: none !important; }
  .harvest-print-page { padding: 0 !important; max-width: none !important; }
  .harvest-print-table thead { display: table-header-group; }
  .harvest-print-table tr { break-inside: avoid; page-break-inside: avoid; }
}
`;

function longDate(key: string): string {
  const { y, m, d } = parseDay(key);
  return `${MONTH_SHORT[m - 1]} ${d}, ${y}`;
}

function rangeText(from: string | null, to: string | null): string {
  if (from && to) return `${longDate(from)} – ${longDate(to)}`;
  // ED: replace with final copy
  if (from) return `From ${longDate(from)}`;
  // ED: replace with final copy
  if (to) return `Until ${longDate(to)}`;
  return 'All dates';
}

function print() {
  track('pdf_harvest_export');
  window.print();
}

// /harvest/print — a printable (save as PDF) harvest log for supporters. Takes
// the CSV export's params: gardenId, seed (repeatable), q, from, to.
export default function HarvestPrintPage() {
  const { account } = useAuth();
  const isSupporter = account?.subscriptionTier === 'supporter';
  if (!isSupporter) return <Navigate to="/harvest" replace />;
  return <HarvestPrint />;
}

function HarvestPrint() {
  const [searchParams] = useSearchParams();
  const { gardens } = useGardenList();

  const gardenParam = searchParams.get('gardenId');
  const gardenId = gardenParam && /^\d+$/.test(gardenParam) ? gardenParam : null;
  const seedKey = searchParams.getAll('seed').join(',');
  const seeds = useMemo(
    () => [...new Set(seedKey.split(',').map(parseSeedParam).filter((s): s is SeedParam => s !== null))],
    [seedKey],
  );
  const qParam = searchParams.get('q')?.trim();
  const q = qParam ? qParam : null;
  const fromParam = searchParams.get('from');
  const toParam = searchParams.get('to');
  const from = fromParam && DATE_RE.test(fromParam) ? fromParam : null;
  const to = toParam && DATE_RE.test(toParam) ? toParam : null;

  const query = harvestQuery({ gardenId, seeds, q, from, to }).toString();

  const [entries, setEntries] = useState<HarvestEntry[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(false);
      try {
        const all: HarvestEntry[] = [];
        const seen = new Set<string>();
        let cursor: string | null = null;
        let more = false;
        do {
          const params = new URLSearchParams(query);
          params.set('limit', String(PAGE_LIMIT));
          if (cursor) params.set('cursor', cursor);
          const res: HarvestListResponse | undefined = await get<HarvestListResponse>(`/api/harvests?${params.toString()}`);
          if (cancelled) return;
          const page = res?.data ?? [];
          all.push(...page);
          cursor = res?.nextCursor ?? null;
          more = cursor !== null || all.length > MAX_ENTRIES;
          // Guard against a stuck cursor: stop on an empty page or a repeat.
          if (page.length === 0 || (cursor !== null && seen.has(cursor))) {
            cursor = null;
            more = all.length > MAX_ENTRIES;
          }
          if (cursor !== null) seen.add(cursor);
        } while (cursor !== null && all.length < MAX_ENTRIES);
        setEntries(all.slice(0, MAX_ENTRIES));
        setTruncated(all.length >= MAX_ENTRIES && more);
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [query, attempt]);

  // Open the print dialog once, after the first successful load. The flag is
  // set inside the timer so a StrictMode effect re-run can't skip or double it.
  const hasEntries = entries.length > 0;
  const canPrint = !loading && !error && hasEntries;
  const autoPrinted = useRef(false);
  useEffect(() => {
    if (loading || error || !hasEntries || autoPrinted.current) return;
    const timer = window.setTimeout(() => {
      if (autoPrinted.current) return;
      autoPrinted.current = true;
      print();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loading, error, hasEntries]);

  // The document title becomes the default PDF file name.
  useEffect(() => {
    const previous = document.title;
    document.title = 'Vernal harvest log';
    return () => {
      document.title = previous;
    };
  }, []);

  // Filters in words, using names from the gardens list and the entries.
  const filterWords = useMemo(() => {
    const parts: string[] = [];
    if (gardenId) {
      const name = gardens.find((g) => g.id === gardenId)?.name ?? entries.find((e) => e.gardenId === gardenId)?.gardenName;
      // ED: replace with final copy
      parts.push(`Garden: ${name ?? 'One garden'}`);
    }
    if (seeds.length > 0) {
      const names = new Map<string, string>();
      for (const e of entries) {
        if (e.commonName) names.set(seedParamOf(e), e.commonName);
      }
      const known = seeds.map((s) => names.get(s)).filter((n): n is string => !!n);
      const unknown = seeds.length - known.length;
      // ED: replace with final copy
      if (unknown > 0) known.push(`${unknown} other ${unknown === 1 ? 'plant' : 'plants'}`);
      // ED: replace with final copy
      parts.push(`${seeds.length === 1 ? 'Plant' : 'Plants'}: ${known.join(', ')}`);
    }
    // ED: replace with final copy
    if (q) parts.push(`Search: “${q}”`);
    return parts.join(' · ');
  }, [gardenId, gardens, seeds, entries, q]);

  // Back to the log with the same filters (all seasons, the date range as custom).
  const currentYear = parseDay(todayPacific()).y;
  const backFilters: HarvestFilters = {
    season: 'all',
    gardenId,
    seeds,
    range: from || to ? 'custom' : 'all',
    from,
    to,
    q,
  };
  const backHref = `/harvest${filterSearch(backFilters, currentYear)}`;

  let body;
  if (loading) {
    body = (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--sp-8) 0' }}>
        {/* ED: replace with final copy */}
        <div style={spinnerStyle} role="status" aria-label="Loading harvests" />
      </div>
    );
  } else if (error) {
    body = (
      <div style={{ padding: 'var(--sp-6) 0', color: 'var(--c-danger)' }}>
        {/* ED: replace with final copy */}
        <p style={{ margin: '0 0 var(--sp-3)' }}>Couldn&rsquo;t load your harvests.</p>
        <button type="button" className="harvest-print-controls" onClick={() => setAttempt((n) => n + 1)} style={textButtonStyle}>
          {/* ED: replace with final copy */}
          Retry
        </button>
      </div>
    );
  } else if (entries.length === 0) {
    // ED: replace with final copy
    body = <p style={{ margin: 'var(--sp-5) 0', color: 'var(--c-text-2)' }}>No harvests match these filters.</p>;
  } else {
    body = (
      <>
        <table className="harvest-print-table" style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Date</th>
              <th style={thStyle}>Plant</th>
              <th style={thStyle}>Garden / Bed</th>
              <th style={thStyle}>Quantity</th>
              <th style={thStyle}>Quality</th>
              <th style={thStyle}>Notes</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>{longDate(e.harvestDate)}</td>
                <td style={tdStyle}>{e.commonName ?? 'Seed no longer in catalogue'}</td>
                <td style={tdStyle}>{e.bedLabel ? `${e.gardenName} / ${e.bedLabel}` : e.gardenName}</td>
                <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>{formatQuantity(e.quantity, e.unit) ?? ''}</td>
                <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>{e.qualityRating !== null ? `${e.qualityRating}/5` : ''}</td>
                <td style={{ ...tdStyle, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{e.notes ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {truncated && (
          <p style={{ margin: 'var(--sp-4) 0 0', fontSize: 13, color: 'var(--c-text-2)' }}>
            This list stops at 2,000 harvests. Narrow the dates or filters to print the rest.
          </p>
        )}
      </>
    );
  }

  return (
    <div
      className="harvest-print-page"
      style={{
        maxWidth: 1000,
        margin: '0 auto',
        padding: 'var(--sp-5) var(--sp-4)',
        boxSizing: 'border-box',
        fontFamily: 'var(--font-ui)',
        color: 'var(--c-text)',
      }}
    >
      <style>{PRINT_CSS}</style>
      <div
        className="harvest-print-controls"
        style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--sp-3)', marginBottom: 'var(--sp-5)' }}
      >
        <button
          type="button"
          onClick={print}
          disabled={!canPrint}
          style={{ ...primaryButtonStyle, ...(canPrint ? null : { opacity: 0.5, cursor: 'not-allowed' }) }}
        >
          Print or save as PDF
        </button>
        <Link to={backHref} style={textButtonStyle}>
          Back to harvest log
        </Link>
      </div>

      <h1 style={{ margin: '0 0 var(--sp-2)', fontFamily: 'var(--font-display)', fontSize: 26, fontWeight: 600 }}>
        Vernal harvest log
      </h1>
      <p style={{ margin: '0 0 var(--sp-1)', fontSize: 15, color: 'var(--c-text-2)' }}>{rangeText(from, to)}</p>
      {filterWords && <p style={{ margin: '0 0 var(--sp-1)', fontSize: 14, color: 'var(--c-text-2)' }}>{filterWords}</p>}
      <div style={{ height: 'var(--sp-4)' }} />
      {body}
    </div>
  );
}

const tableStyle: CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: 13,
  lineHeight: 1.45,
};

const thStyle: CSSProperties = {
  textAlign: 'left',
  verticalAlign: 'bottom',
  padding: 'var(--sp-2)',
  borderBottom: '2px solid var(--c-border)',
  fontWeight: 600,
  color: 'var(--c-text)',
};

const tdStyle: CSSProperties = {
  textAlign: 'left',
  verticalAlign: 'top',
  padding: 'var(--sp-2)',
  borderBottom: '1px solid var(--c-border-subtle)',
};
