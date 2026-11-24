import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useIsMobile } from '../hooks/useIsMobile';
import { usePlantingGuide } from '../hooks/usePlantingGuide';
import { parseDay, todayPacific } from '../lib/guideDates';
import { filterRows, hasWindows, rowKey, type GuideFilterState, type GuideView } from '../lib/guideModel';
import { useMicroFeedback } from '../lib/microFeedback';
import * as api from '../lib/api';
import type { Planting } from '../hooks/usePlantings';
import { parseGuideDeepLink, withoutGuideDeepLink, type GuideDeepLink } from '../lib/guideDeepLink';
import { FROST_COPY } from '../lib/frostLabels';
import type { GuideOverrides, GuideRow } from '../types/plantingGuide';
import ZoneStrip from '../components/guide/ZoneStrip';
import SeasonSelector from '../components/guide/SeasonSelector';
import ViewToggle from '../components/guide/ViewToggle';
import GuideFilters from '../components/guide/GuideFilters';
import FrostBanner from '../components/guide/FrostBanner';
import Legend from '../components/guide/Legend';
import CalendarView from '../components/guide/CalendarView';
import TimelineView from '../components/guide/TimelineView';
import ListView from '../components/guide/ListView';
import PlantSchedule from '../components/guide/PlantSchedule';
import { primaryButtonStyle, textButtonStyle } from '../components/guide/styles';

const VIEW_KEY = 'vernal.guide.view';
const VIEWS: GuideView[] = ['calendar', 'timeline', 'list'];

function readStoredView(): GuideView | null {
  try {
    const v = window.localStorage.getItem(VIEW_KEY);
    return VIEWS.includes(v as GuideView) ? (v as GuideView) : null;
  } catch {
    return null;
  }
}

function storeView(view: GuideView): void {
  try {
    window.localStorage.setItem(VIEW_KEY, view);
  } catch {
    // storage unavailable — the choice lasts for this page view only
  }
}

const OPEN_PARAM_RE = /^(seed|cambium):(\d+)$/;
const FROST_SAVED_MS = 3_000;

function findDeepLinkRow(rows: GuideRow[], param: string): GuideRow | undefined {
  const m = OPEN_PARAM_RE.exec(param);
  if (!m) return undefined;
  return m[1] === 'seed'
    ? rows.find((r) => r.seedId === m[2])
    : rows.find((r) => r.seedId === null && r.cambiumSeedId === m[2]);
}

// Fixed toast above the bottom shell.
const toastStyle: CSSProperties = {
  position: 'fixed',
  left: '50%',
  transform: 'translateX(-50%)',
  bottom: 'calc(var(--shell-bottom, 0px) + 16px + var(--deletion-banner-h, 0px))',
  zIndex: 1060,
  width: 'max-content',
  maxWidth: 'calc(100vw - 32px)',
  boxSizing: 'border-box',
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--sp-2)',
  padding: 'var(--sp-1) var(--sp-1) var(--sp-1) var(--sp-4)',
  background: 'var(--c-surface)',
  border: '1px solid var(--c-border)',
  borderRadius: 'var(--r-lg)',
  boxShadow: 'var(--shadow-lg)',
  fontSize: 14,
  color: 'var(--c-text)',
};

const noticeStyle: CSSProperties = {
  margin: 0,
  padding: 'var(--sp-3) var(--sp-4)',
  background: 'var(--c-info-bg)',
  color: 'var(--c-text)',
  borderRadius: 'var(--r-md)',
  fontFamily: 'var(--font-ui)',
  fontSize: 14,
};

export default function PlantingGuidePage() {
  const { isAccount } = useAuth();
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  // null until the user picks a season: the first load asks the server for
  // its current season. A deep link (?season=<year>, with or without
  // ?open=… / ?gardenId=…) loads that season.
  const [season, setSeason] = useState<number | null>(() => parseGuideDeepLink(searchParams)?.season ?? null);
  const { data, loading, error, reload, setOverrides } = usePlantingGuide(season);
  const requestFeedback = useMicroFeedback();

  // The page strip's frost-date editor, also opened from the frost banner.
  const [frostEditorOpen, setFrostEditorOpen] = useState(false);
  // Bumped on each save so a second save restarts the toast timer.
  const [frostSavedToast, setFrostSavedToast] = useState(0);
  useEffect(() => {
    if (!frostSavedToast) return;
    const timer = window.setTimeout(() => setFrostSavedToast(0), FROST_SAVED_MS);
    return () => window.clearTimeout(timer);
  }, [frostSavedToast]);
  const onFrostSaved = useCallback(() => {
    setFrostEditorOpen(false);
    void reload();
    setFrostSavedToast((n) => n + 1);
  }, [reload]);

  const setOverridesAndPrompt = useCallback(
    async (row: GuideRow, partial: Partial<GuideOverrides>) => {
      await setOverrides(row, partial);
      requestFeedback('first_sowing');
    },
    [setOverrides, requestFeedback],
  );

  const [view, setView] = useState<GuideView>(() => readStoredView() ?? (isMobile ? 'list' : 'calendar'));
  const [filters, setFilters] = useState<GuideFilterState>({ gardenId: 'all', sowType: 'all', dueThisMonth: false });
  const [openRowKey, setOpenRowKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const today = todayPacific();
  const currentMonth = parseDay(today).m;

  // Plantings for every garden in the viewed season, for the Planned tag and
  // nudges. A garden whose request fails gets no tag or nudge. Responses for
  // a season (or garden set) we've moved away from are dropped.
  const [plantings, setPlantings] = useState<Planting[]>([]);
  const plantingsRequest = useRef(0);
  const plantingsSeason = data?.season;
  const plantingsGardenIds = data ? data.gardens.map((g) => g.id).join(',') : '';
  useEffect(() => {
    const id = ++plantingsRequest.current;
    setPlantings([]);
    if (plantingsSeason === undefined || plantingsGardenIds === '') return;
    const gardenIds = plantingsGardenIds.split(',');
    void Promise.all(
      gardenIds.map((gardenId) =>
        api
          .get<{ data: Planting[] }>(`/api/gardens/${gardenId}/plantings?season=${plantingsSeason}`)
          .then((res) => res?.data ?? [])
          .catch(() => [] as Planting[]),
      ),
    ).then((lists) => {
      if (id !== plantingsRequest.current) return;
      setPlantings(lists.flat());
    });
    return () => {
      plantingsRequest.current++;
    };
  }, [plantingsSeason, plantingsGardenIds]);

  // Deep link: ?season=<year>, ?gardenId=<id>, ?open=seed:<id> | cambium:<id>.
  // Read whenever the params appear — including a bell click while already on
  // /guide, which doesn't remount the page. The season is switched at once;
  // the garden filter and open plant wait for that season's data. The params
  // are then cleared from the URL.
  const [pendingLink, setPendingLink] = useState<GuideDeepLink | null>(null);
  useEffect(() => {
    const link = parseGuideDeepLink(searchParams);
    if (!link) return;
    setPendingLink(link);
    setNotice(null);
    if (link.season !== null) setSeason(link.season);
    setSearchParams(withoutGuideDeepLink(searchParams), { replace: true });
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    if (!pendingLink || !data) return;
    if (pendingLink.season !== null && data.season !== pendingLink.season) {
      // Still loading that season; drop the link if the load failed.
      if (!loading && error) setPendingLink(null);
      return;
    }
    setPendingLink(null);
    if (pendingLink.gardenId !== null && data.gardens.some((g) => g.id === pendingLink.gardenId)) {
      const gardenId = pendingLink.gardenId;
      setFilters((f) => ({ ...f, gardenId }));
    }
    if (pendingLink.open !== null) {
      const row = findDeepLinkRow(data.rows, pendingLink.open);
      if (row) setOpenRowKey(rowKey(row));
      else setNotice("This seed isn't planted in any garden this season.");
    }
  }, [pendingLink, data, loading, error]);

  function changeView(next: GuideView) {
    setView(next);
    storeView(next);
  }

  function changeSeason(next: number) {
    setSeason(next);
    setNotice(null);
  }

  const pagePadding = isMobile ? 'var(--sp-4)' : 'var(--sp-6) var(--sp-5)';

  if (!data) {
    return (
      <div style={{ maxWidth: 1280, margin: '0 auto', padding: pagePadding, fontFamily: 'var(--font-ui)' }}>
        {loading && (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--sp-9) 0' }}>
            <div style={{ width: 32, height: 32, border: '2px solid var(--c-primary-light)', borderTopColor: 'var(--c-primary)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
          </div>
        )}
        {error && !loading && (
          <div style={{ textAlign: 'center', color: 'var(--c-danger)', padding: 'var(--sp-7) 0' }}>
            {error}{' '}
            <button type="button" onClick={() => void reload()} style={textButtonStyle}>Retry</button>
          </div>
        )}
      </div>
    );
  }

  const isCurrentSeason = data.season === data.currentSeason;
  const multipleGardens = data.gardens.length > 1;
  const gardenInView = (filters.gardenId !== 'all' && data.gardens.find((g) => g.id === filters.gardenId)) || data.gardens[0];
  const filteredRows = filterRows(data.rows, filters, data.season, currentMonth);
  const openRow = openRowKey ? data.rows.find((r) => rowKey(r) === openRowKey) : undefined;
  const openIndex = openRow ? filteredRows.findIndex((r) => rowKey(r) === openRowKey) : -1;

  const viewProps = {
    rows: filteredRows,
    gardens: data.gardens,
    season: data.season,
    isCurrentSeason,
    today,
    showGardenName: multipleGardens,
    isMobile,
    onOpen: (row: GuideRow) => setOpenRowKey(rowKey(row)),
  };

  return (
    <div style={{ maxWidth: 1280, width: '100%', boxSizing: 'border-box', margin: '0 auto', padding: pagePadding, fontFamily: 'var(--font-ui)', background: 'var(--c-bg)' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)', marginBottom: 'var(--sp-4)' }}>
        {!isMobile && (
          <h1 style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 30, fontWeight: 600, color: 'var(--c-text)' }}>
            Planting Guide
          </h1>
        )}
        {gardenInView && (
          <ZoneStrip
            garden={gardenInView}
            isAccount={isAccount}
            editorOpen={frostEditorOpen}
            onEditorOpenChange={setFrostEditorOpen}
            onFrostSaved={onFrostSaved}
          />
        )}

        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--sp-3)' }}>
          <SeasonSelector currentSeason={data.currentSeason} season={data.season} onChange={changeSeason} />
          <ViewToggle view={view} onChange={changeView} />
          <GuideFilters filters={filters} onChange={setFilters} gardens={data.gardens} isMobile={isMobile} />
        </div>

        {gardenInView && (
          <FrostBanner
            key={`${data.season}-${gardenInView.id}`}
            garden={gardenInView}
            season={data.season}
            today={today}
            isAccount={isAccount}
            onSetDate={() => setFrostEditorOpen(true)}
          />
        )}
        <Legend />

        {data.readOnly && <p role="status" style={noticeStyle}>Past seasons are read-only.</p>}
        {notice && <p role="status" style={noticeStyle}>{notice}</p>}
      </div>

      {data.rows.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 'var(--sp-8) var(--sp-4)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--sp-4)' }}>
          <p style={{ margin: 0, fontSize: 16, color: 'var(--c-text-2)', maxWidth: 420 }}>
            Place some plants on your garden canvas and your planting guide will appear here.
          </p>
          <button type="button" onClick={() => navigate('/')} style={primaryButtonStyle}>
            Go to your garden
          </button>
        </div>
      ) : (
        <>
          {!data.rows.some(hasWindows) && (
            <p style={{ ...noticeStyle, marginBottom: 'var(--sp-4)' }}>
              Your plants are here, but we don&rsquo;t have planting dates for them yet. You can add dates from each plant&rsquo;s schedule.
            </p>
          )}
          {view === 'calendar' && <CalendarView {...viewProps} />}
          {view === 'timeline' && <TimelineView {...viewProps} />}
          {view === 'list' && <ListView {...viewProps} readOnly={data.readOnly} plantings={plantings} />}
          {view !== 'list' && filteredRows.length === 0 && (
            <p style={{ fontSize: 14, color: 'var(--c-text-3)' }}>No plants to show for the current filters.</p>
          )}
        </>
      )}

      {openRow && (
        <PlantSchedule
          key={openRowKey}
          row={openRow}
          garden={data.gardens.find((g) => g.id === openRow.gardenId)}
          readOnly={data.readOnly}
          plantings={plantings}
          season={data.season}
          today={today}
          isAccount={isAccount}
          isMobile={isMobile}
          onClose={() => setOpenRowKey(null)}
          onPrev={openIndex > 0 ? () => setOpenRowKey(rowKey(filteredRows[openIndex - 1])) : null}
          onNext={openIndex >= 0 && openIndex < filteredRows.length - 1 ? () => setOpenRowKey(rowKey(filteredRows[openIndex + 1])) : null}
          setOverrides={setOverridesAndPrompt}
          onFrostSaved={onFrostSaved}
        />
      )}

      {frostSavedToast > 0 && (
        <div role="status" style={{ ...toastStyle, padding: 'var(--sp-3) var(--sp-4)' }}>
          <span>{FROST_COPY.saved}</span>
        </div>
      )}
    </div>
  );
}
