import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useIsMobile } from '../hooks/useIsMobile';
import { usePlantingGuide } from '../hooks/usePlantingGuide';
import { parseDay, todayPacific } from '../lib/guideDates';
import { filterRows, hasWindows, rowKey, seedParam, type GuideFilterState, type GuideView } from '../lib/guideModel';
import { useMicroFeedback } from '../lib/microFeedback';
import type { GuideOverrides, GuideRow } from '../types/plantingGuide';
import { CloseIcon } from '../components/shell/icons';
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
import { iconButtonStyle, primaryButtonStyle, textButtonStyle } from '../components/guide/styles';

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
const LOG_PROMPT_MS = 10_000;

function findDeepLinkRow(rows: GuideRow[], param: string): GuideRow | undefined {
  const m = OPEN_PARAM_RE.exec(param);
  if (!m) return undefined;
  return m[1] === 'seed'
    ? rows.find((r) => r.seedId === m[2])
    : rows.find((r) => r.seedId === null && r.cambiumSeedId === m[2]);
}

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
  // its current season. A deep link (?open=…&season=<year>) loads that season.
  const [season, setSeason] = useState<number | null>(() => {
    const s = searchParams.get('season');
    return searchParams.get('open') !== null && s !== null && /^\d{4}$/.test(s) ? Number(s) : null;
  });
  const { data, loading, error, reload, setOverrides, setDone } = usePlantingGuide(season);
  const requestFeedback = useMicroFeedback();

  // "Marked done. Log your harvest?" after a plant is marked done.
  const [logPromptRow, setLogPromptRow] = useState<GuideRow | null>(null);
  useEffect(() => {
    if (!logPromptRow) return;
    const timer = window.setTimeout(() => setLogPromptRow(null), LOG_PROMPT_MS);
    return () => window.clearTimeout(timer);
  }, [logPromptRow]);

  const readOnly = data?.readOnly ?? true;
  const setDoneAndPrompt = useCallback(
    async (row: GuideRow, done: boolean) => {
      await setDone(row, done);
      if (!done) return;
      requestFeedback('first_sowing');
      if (!readOnly) setLogPromptRow(row);
    },
    [setDone, requestFeedback, readOnly],
  );
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
  const [doneError, setDoneError] = useState<string | null>(null);

  const today = todayPacific();
  const currentMonth = parseDay(today).m;

  // ?open=seed:<id> | cambium:<id> — handled once, against the first load.
  const deepLinkHandled = useRef(false);
  useEffect(() => {
    if (!data || deepLinkHandled.current) return;
    deepLinkHandled.current = true;
    const param = searchParams.get('open');
    if (param === null) return;
    const row = findDeepLinkRow(data.rows, param);
    if (row) setOpenRowKey(rowKey(row));
    else setNotice("This seed isn't planted in any garden this season.");
    const next = new URLSearchParams(searchParams);
    next.delete('open');
    next.delete('season');
    setSearchParams(next, { replace: true });
  }, [data, searchParams, setSearchParams]);

  function changeView(next: GuideView) {
    setView(next);
    storeView(next);
  }

  function changeSeason(next: number) {
    setSeason(next);
    setNotice(null);
  }

  async function toggleDone(row: GuideRow, done: boolean) {
    setDoneError(null);
    try {
      await setDoneAndPrompt(row, done);
    } catch {
      setDoneError(`Couldn't save ${row.commonName ?? 'that plant'}. Try again.`);
    }
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
        {gardenInView && <ZoneStrip garden={gardenInView} isAccount={isAccount} />}

        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--sp-3)' }}>
          <SeasonSelector currentSeason={data.currentSeason} season={data.season} onChange={changeSeason} />
          <ViewToggle view={view} onChange={changeView} />
          <GuideFilters filters={filters} onChange={setFilters} gardens={data.gardens} isMobile={isMobile} />
        </div>

        {gardenInView && <FrostBanner key={`${data.season}-${gardenInView.id}`} garden={gardenInView} season={data.season} today={today} />}
        <Legend />

        {data.readOnly && <p role="status" style={noticeStyle}>Past seasons are read-only.</p>}
        {notice && <p role="status" style={noticeStyle}>{notice}</p>}
        {doneError && <p role="alert" style={{ ...noticeStyle, background: 'var(--c-danger-bg)' }}>{doneError}</p>}
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
          {view === 'list' && <ListView {...viewProps} readOnly={data.readOnly} onToggleDone={(row, done) => void toggleDone(row, done)} />}
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
          isAccount={isAccount}
          isMobile={isMobile}
          onClose={() => setOpenRowKey(null)}
          onPrev={openIndex > 0 ? () => setOpenRowKey(rowKey(filteredRows[openIndex - 1])) : null}
          onNext={openIndex >= 0 && openIndex < filteredRows.length - 1 ? () => setOpenRowKey(rowKey(filteredRows[openIndex + 1])) : null}
          setOverrides={setOverridesAndPrompt}
          setDone={setDoneAndPrompt}
        />
      )}

      {logPromptRow && (
        <div
          role="status"
          style={{
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
          }}
        >
          <span>Marked done. Log your harvest?</span>
          <Link
            to={`/harvest?log=new&gardenId=${logPromptRow.gardenId}&seed=${seedParam(logPromptRow)}`}
            style={{ ...primaryButtonStyle, padding: '0 var(--sp-3)' }}
          >
            Log harvest
          </Link>
          <button type="button" aria-label="Dismiss" onClick={() => setLogPromptRow(null)} style={iconButtonStyle}>
            <CloseIcon width={18} height={18} />
          </button>
        </div>
      )}
    </div>
  );
}
