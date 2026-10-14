import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useRegisterCanvas } from '../context/CanvasPresenceContext';
import { useGardenList } from '../hooks/useGardenList';
import { useIsMobile } from '../hooks/useIsMobile';
import { useComparablePlants } from '../hooks/useMetrics';
import { parseSeedParam, useHarvests } from '../hooks/useHarvests';
import { parseDay, todayPacific } from '../lib/guideDates';
import {
  defaultFilters,
  exportRange,
  filterChips,
  filterSearch,
  isFiltered,
  readFilters,
  toApiFilters,
  writeFilters,
  type HarvestFilters,
} from '../lib/harvestFilters';
import type { PlantOption } from '../types/harvest';
import BottomSheet from '../components/shell/BottomSheet';
import { CloseIcon } from '../components/shell/icons';
import HarvestEntryForm, { type FormMode, type FormResult } from '../components/harvest/HarvestEntryForm';
import HarvestDetail from '../components/harvest/HarvestDetail';
import HarvestList from '../components/harvest/HarvestList';
import ExportPanel from '../components/harvest/ExportPanel';
import { FilterChips, HarvestFilterControls } from '../components/harvest/HarvestFilters';
import { plantKeyOf } from '../components/metrics/styles';
import {
  iconButtonStyle,
  primaryButtonStyle,
  spinnerStyle,
  textButtonStyle,
  textLinkButtonStyle,
} from '../components/harvest/formStyles';

const HIGHLIGHT_MS = 1100;
const TOAST_MS = 3000;

// /harvest and /harvest/:entryId (Harvest Log spec 6.2 / 6.3). Filters live in
// the URL; ?log=new | ?log=<entryId> opens the entry form over the page.
export default function HarvestLogPage() {
  const isMobile = useIsMobile();
  const { account, isAccount } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { entryId = null } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const { gardens } = useGardenList();

  const today = todayPacific();
  const currentYear = parseDay(today).y;

  // ── Form state from the URL ─────────────────────────────────────────────────
  const log = searchParams.get('log');
  // Set when this page opened the form, so closing it can go back.
  const formPushed = (location.state as { harvestForm?: boolean } | null)?.harvestForm === true;
  // A ?log=new link from elsewhere carries gardenId/seed as form prefill.
  const prefillLink = log === 'new' && !formPushed;
  const prefillGarden = prefillLink ? searchParams.get('gardenId') : null;
  const prefillSeedRaw = prefillLink ? searchParams.get('seed') : null;
  const formMode = useMemo<FormMode | null>(() => {
    if (log === 'new') {
      return {
        kind: 'new',
        gardenId: prefillGarden && /^\d+$/.test(prefillGarden) ? prefillGarden : null,
        seed: parseSeedParam(prefillSeedRaw),
      };
    }
    if (log && /^\d+$/.test(log)) return { kind: 'edit', entryId: log };
    return null;
  }, [log, prefillGarden, prefillSeedRaw]);

  // ── Filters ─────────────────────────────────────────────────────────────────
  const filters = useMemo(
    () => readFilters(searchParams, currentYear, prefillLink),
    [searchParams, currentYear, prefillLink],
  );
  const apiFilters = useMemo(() => toApiFilters(filters, today), [filters, today]);
  const listSearch = filterSearch(filters, currentYear);
  const filtered = isFiltered(filters, currentYear);

  const { entries, seasons, nextCursor, loading, loadingMore, error, reload, loadMore, removeEntry } =
    useHarvests(apiFilters);

  const setFilters = useCallback(
    (next: HarvestFilters) => {
      setSearchParams((prev) => writeFilters(prev, next, currentYear), { replace: true });
    },
    [setSearchParams, currentYear],
  );
  const clearFilters = useCallback(() => setFilters(defaultFilters(currentYear)), [setFilters, currentYear]);

  // Plant names for the seed chips, learned from the list and the picker.
  const [seedNames, setSeedNames] = useState<Record<string, string>>({});
  useEffect(() => {
    setSeedNames((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const e of entries) {
        const key = e.seedId !== null ? `seed:${e.seedId}` : `cambium:${e.cambiumSeedId}`;
        if (e.commonName && next[key] !== e.commonName) {
          next[key] = e.commonName;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [entries]);
  const rememberPlant = useCallback((o: PlantOption) => {
    const key = o.seedId !== null ? `seed:${o.seedId}` : `cambium:${o.cambiumSeedId}`;
    if (o.commonName) setSeedNames((prev) => ({ ...prev, [key]: o.commonName! }));
  }, []);

  // "Compare seasons" when the one filtered plant has 2+ seasons (accounts only).
  const { plants: comparablePlants } = useComparablePlants(isAccount && filters.seeds.length === 1);
  const compareKey =
    isAccount &&
    filters.seeds.length === 1 &&
    comparablePlants.some((p) => plantKeyOf(p) === filters.seeds[0])
      ? filters.seeds[0]
      : null;

  const chips = filterChips(filters, currentYear, {
    garden: (id) => gardens.find((g) => g.id === id)?.name ?? 'Garden',
    seed: (s) => seedNames[s] ?? 'Plant',
  });

  const seasonOptions = useMemo(() => {
    const years = new Set<number>([currentYear, ...seasons]);
    if (typeof filters.season === 'number') years.add(filters.season);
    return [...years].sort((a, b) => b - a);
  }, [currentYear, seasons, filters.season]);

  // ── Page state ──────────────────────────────────────────────────────────────
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [photoNotice, setPhotoNotice] = useState<string | null>(null);
  const [detailVersion, setDetailVersion] = useState(0);
  const [exportOpen, setExportOpen] = useState(false);
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);
  const highlightTimer = useRef<number | undefined>(undefined);
  const toastTimer = useRef<number | undefined>(undefined);
  useEffect(
    () => () => {
      window.clearTimeout(highlightTimer.current);
      window.clearTimeout(toastTimer.current);
    },
    [],
  );

  // The feedback button moves left while the "+" button holds the right edge.
  useRegisterCanvas(isMobile && entryId === null);

  // ── Form open / close ───────────────────────────────────────────────────────
  function openForm(value: string) {
    const next = new URLSearchParams(searchParams);
    next.set('log', value);
    navigate({ pathname: location.pathname, search: `?${next.toString()}` }, { state: { harvestForm: true } });
  }

  function closeForm() {
    if (formPushed) {
      navigate(-1);
      return;
    }
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (next.get('log') === 'new') {
          next.delete('gardenId');
          next.delete('seed');
        }
        next.delete('log');
        return next;
      },
      { replace: true },
    );
  }

  function onSaved(result: FormResult) {
    closeForm();
    void reload();
    setDetailVersion((v) => v + 1);

    window.clearTimeout(highlightTimer.current);
    setHighlightId(result.entryId);
    highlightTimer.current = window.setTimeout(() => setHighlightId(null), HIGHLIGHT_MS);

    if (result.storageUnavailable) setPhotoNotice("Photo storage isn't available right now.");
    else if (result.photoFailures > 0) {
      setPhotoNotice(
        `${result.photoFailures} ${result.photoFailures === 1 ? "photo didn't" : "photos didn't"} upload. Edit the entry to try again.`,
      );
    } else setPhotoNotice(null);

    if (isMobile) {
      window.clearTimeout(toastTimer.current);
      setToast('Harvest saved');
      toastTimer.current = window.setTimeout(() => setToast(null), TOAST_MS);
    }
  }

  function onDeleted(id: string) {
    removeEntry(id);
    navigate(`/harvest${listSearch}`, { replace: isMobile });
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  const isSupporter = account?.subscriptionTier === 'supporter';
  const range = exportRange(filters, today);

  const form = formMode && (
    <HarvestEntryForm
      key={log ?? ''}
      mode={formMode}
      isMobile={isMobile}
      defaultGardenId={filters.gardenId}
      onClose={closeForm}
      onSaved={onSaved}
      onDeleted={onDeleted}
    />
  );

  const exportPanel = exportOpen && (
    <ExportPanel
      isMobile={isMobile}
      onClose={() => setExportOpen(false)}
      defaultFrom={range.from}
      defaultTo={range.to}
      gardenId={filters.gardenId}
      seeds={filters.seeds}
      q={filters.q}
      isSupporter={isSupporter}
    />
  );

  const exportButton = (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        data-export-toggle
        aria-expanded={exportOpen}
        onClick={() => setExportOpen((o) => !o)}
        style={textButtonStyle}
      >
        Export
      </button>
      {!isMobile && exportPanel}
    </div>
  );

  // Borderless header links; tighter padding on mobile so the header fits 360px.
  const headerLinkStyle = {
    ...textButtonStyle,
    border: 'none',
    color: 'var(--c-primary)',
    fontWeight: 600,
    ...(isMobile ? { padding: '0 var(--sp-2)' } : null),
  };

  const weatherLink = (
    <Link to="/weather" style={headerLinkStyle}>
      Weather
    </Link>
  );

  const dataLink = (
    <Link to="/data" style={headerLinkStyle}>
      Data
    </Link>
  );

  const compareLink = compareKey && (
    <Link
      to={`/data/compare?plant=${encodeURIComponent(compareKey)}`}
      style={{ ...textLinkButtonStyle, padding: 0 }}
    >
      Compare seasons
    </Link>
  );

  const notice = photoNotice && (
    <div
      role="status"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--sp-2)',
        margin: '0 0 var(--sp-3)',
        padding: '0 0 0 var(--sp-4)',
        background: 'var(--c-warning-bg)',
        color: 'var(--c-text)',
        borderRadius: 'var(--r-md)',
        fontSize: 14,
      }}
    >
      <span style={{ flex: 1 }}>{photoNotice}</span>
      <button type="button" aria-label="Dismiss" onClick={() => setPhotoNotice(null)} style={iconButtonStyle}>
        <CloseIcon width={18} height={18} />
      </button>
    </div>
  );

  let listBody;
  if (loading && entries.length === 0) {
    listBody = (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--sp-8) 0' }}>
        <div style={spinnerStyle} role="status" aria-label="Loading harvests" />
      </div>
    );
  } else if (error && entries.length === 0) {
    listBody = (
      <div style={{ textAlign: 'center', padding: 'var(--sp-7) 0', color: 'var(--c-danger)' }}>
        <p style={{ margin: '0 0 var(--sp-3)' }}>Couldn&rsquo;t load your harvests.</p>
        <button type="button" onClick={() => void reload()} style={textButtonStyle}>Retry</button>
      </div>
    );
  } else if (entries.length === 0 && !filtered && seasons.length === 0) {
    listBody = (
      <div style={{ textAlign: 'center', padding: 'var(--sp-7) var(--sp-4)', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <div
          aria-hidden="true"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 56,
            height: 56,
            borderRadius: 'var(--r-full)',
            background: 'var(--c-primary-subtle)',
            marginBottom: 'var(--sp-4)',
            fontSize: 24,
          }}
        >
          🌱
        </div>
        <p style={{ margin: '0 0 var(--sp-5)', maxWidth: 360, fontSize: 16, lineHeight: 1.6, color: 'var(--c-text-2)' }}>
          Your first harvest is waiting. When you pick something, log it here.
        </p>
        <button type="button" onClick={() => openForm('new')} style={primaryButtonStyle}>
          Log harvest
        </button>
      </div>
    );
  } else if (entries.length === 0) {
    listBody = (
      <div style={{ textAlign: 'center', padding: 'var(--sp-7) var(--sp-4)', color: 'var(--c-text-2)', fontSize: 15 }}>
        {filtered ? (
          <>
            <p style={{ margin: '0 0 var(--sp-2)' }}>No harvests match these filters.</p>
            <button type="button" onClick={clearFilters} style={textLinkButtonStyle}>Clear all</button>
          </>
        ) : (
          <p style={{ margin: 0 }}>No harvests logged in {currentYear} yet.</p>
        )}
      </div>
    );
  } else {
    listBody = (
      <HarvestList
        entries={entries}
        selectedId={entryId}
        highlightId={highlightId}
        listSearch={listSearch}
        isMobile={isMobile}
        hasMore={nextCursor !== null}
        loadingMore={loadingMore}
        onLoadMore={() => void loadMore()}
      />
    );
  }

  // ── Mobile ──────────────────────────────────────────────────────────────────
  if (isMobile) {
    const toastEl = toast && (
      <div
        role="status"
        style={{
          position: 'fixed',
          left: '50%',
          transform: 'translateX(-50%)',
          bottom: 'calc(var(--shell-bottom, 0px) + 88px)',
          zIndex: 1060,
          padding: 'var(--sp-3) var(--sp-5)',
          background: 'var(--c-text)',
          color: 'var(--c-text-on-primary)',
          borderRadius: 'var(--r-full)',
          boxShadow: 'var(--shadow-lg)',
          fontFamily: 'var(--font-ui)',
          fontSize: 14,
          fontWeight: 600,
          whiteSpace: 'nowrap',
        }}
      >
        {toast}
      </div>
    );

    if (entryId !== null) {
      return (
        <div style={{ fontFamily: 'var(--font-ui)', background: 'var(--c-bg)', minHeight: '100%' }}>
          <HarvestDetail
            entryId={entryId}
            isMobile
            version={detailVersion}
            listSearch={listSearch}
            onEdit={() => openForm(entryId)}
            onDeleted={onDeleted}
          />
          {form}
          {toastEl}
        </div>
      );
    }

    return (
      <div style={{ padding: 'var(--sp-3) var(--sp-4) calc(var(--sp-9) + var(--sp-4))', fontFamily: 'var(--font-ui)', background: 'var(--c-bg)', boxSizing: 'border-box', width: '100%' }}>
        {/* Wraps at narrow widths: the Weather / Data pair drops to its own row, right-aligned. */}
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--sp-2)', marginBottom: 'var(--sp-3)' }}>
          <button type="button" onClick={() => setFilterSheetOpen(true)} style={textButtonStyle}>
            Filter{chips.length > 0 ? ` (${chips.length})` : ''}
          </button>
          {exportButton}
          <div style={{ display: 'flex', alignItems: 'center', marginLeft: 'auto' }}>
            {weatherLink}
            {dataLink}
          </div>
        </div>
        {chips.length > 0 && (
          <div style={{ marginBottom: 'var(--sp-3)' }}>
            <FilterChips chips={chips} filters={filters} onChange={setFilters} onClearAll={clearFilters} scroll />
          </div>
        )}
        {compareLink && <div style={{ marginBottom: 'var(--sp-3)' }}>{compareLink}</div>}
        {notice}
        {listBody}

        <button
          type="button"
          aria-label="Log harvest"
          onClick={() => openForm('new')}
          style={{
            position: 'fixed',
            right: 16,
            bottom: 'calc(var(--shell-bottom) + 16px)',
            zIndex: 45,
            width: 56,
            height: 56,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 0,
            border: 'none',
            borderRadius: 'var(--r-full)',
            background: 'var(--c-primary)',
            color: 'var(--c-text-on-primary)',
            boxShadow: 'var(--shadow-lg)',
            fontSize: 30,
            lineHeight: 1,
            cursor: 'pointer',
          }}
        >
          <span aria-hidden="true">+</span>
        </button>

        <BottomSheet open={filterSheetOpen} onClose={() => setFilterSheetOpen(false)} title="Filter harvests">
          <div style={{ padding: '0 var(--sp-4) var(--sp-4)' }}>
            <HarvestFilterControls
              filters={filters}
              onChange={setFilters}
              gardens={gardens}
              seasonOptions={seasonOptions}
              layout="stack"
              onPlantChosen={rememberPlant}
            />
            {chips.length > 0 && (
              <button type="button" onClick={clearFilters} style={textLinkButtonStyle}>Clear all</button>
            )}
          </div>
        </BottomSheet>
        {exportPanel}
        {form}
        {toastEl}
      </div>
    );
  }

  // ── Desktop ─────────────────────────────────────────────────────────────────
  return (
    <div style={{ maxWidth: 1280, width: '100%', boxSizing: 'border-box', margin: '0 auto', padding: 'var(--sp-6) var(--sp-5)', fontFamily: 'var(--font-ui)', background: 'var(--c-bg)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-3)', marginBottom: 'var(--sp-4)' }}>
        <h1 style={{ flex: 1, margin: 0, fontFamily: 'var(--font-display)', fontSize: 30, fontWeight: 600, color: 'var(--c-text)' }}>
          Harvest log
        </h1>
        {exportButton}
        {weatherLink}
        {dataLink}
        <button type="button" onClick={() => openForm('new')} style={primaryButtonStyle}>
          Log harvest
        </button>
      </div>

      <div style={{ marginBottom: 'var(--sp-3)' }}>
        <HarvestFilterControls
          filters={filters}
          onChange={setFilters}
          gardens={gardens}
          seasonOptions={seasonOptions}
          layout="bar"
          onPlantChosen={rememberPlant}
        />
      </div>
      {chips.length > 0 && (
        <div style={{ marginBottom: 'var(--sp-3)' }}>
          <FilterChips chips={chips} filters={filters} onChange={setFilters} onClearAll={clearFilters} scroll={false} />
        </div>
      )}
      {compareLink && <div style={{ marginBottom: 'var(--sp-3)' }}>{compareLink}</div>}
      {notice}

      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--sp-5)' }}>
        <div style={{ flex: '0 0 40%', minWidth: 360 }}>{listBody}</div>
        <div
          style={{
            flex: 1,
            minWidth: 0,
            position: 'sticky',
            top: 'var(--sp-4)',
            background: 'var(--c-surface)',
            border: '1px solid var(--c-border-subtle)',
            borderRadius: 'var(--r-lg)',
            minHeight: 240,
          }}
        >
          {entryId !== null ? (
            <HarvestDetail
              key={entryId}
              entryId={entryId}
              isMobile={false}
              version={detailVersion}
              listSearch={listSearch}
              onEdit={() => openForm(entryId)}
              onDeleted={onDeleted}
            />
          ) : (
            <p style={{ margin: 0, padding: 'var(--sp-7) var(--sp-5)', textAlign: 'center', color: 'var(--c-text-3)', fontSize: 15 }}>
              Select a harvest to see its details.
            </p>
          )}
        </div>
      </div>

      {form}
    </div>
  );
}
