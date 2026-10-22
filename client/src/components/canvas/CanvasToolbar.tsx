import type { GardenSummary } from '../../hooks/useGardenList';
import { useIsMobile } from '../../hooks/useIsMobile';
import { linkStyle } from '../guide/styles';

export type CanvasMode = 'grid' | 'freeform';

interface Props {
  scale: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onResetZoom: () => void;
  gardens: GardenSummary[];
  activeGardenId: string;
  onGardenChange: (id: string) => void;
  mode: CanvasMode;
  onModeChange: (mode: CanvasMode) => void;
  panActive: boolean;
  onPanToggle: () => void;
  bedManagerOpen: boolean;
  onBedManagerToggle: () => void;
  conflictCount?: number;
  onJumpToConflict?: () => void;
  // Phase 50: past-season overlay. overlaySeason null = this season only.
  currentSeason: number;
  earlierSeasons: number[];
  overlaySeason: number | null;
  overlayStatus: SeasonOverlayStatus;
  onOverlaySeasonChange: (season: number | null) => void;
}

export type SeasonOverlayStatus = 'off' | 'loading' | 'ready' | 'empty' | 'error';

// Mirrors the Phase 46 SeasonSelector (guide/styles segment styles): tokens,
// 44px minimum hit area.
const seasonSelectStyle: React.CSSProperties = {
  height: 44,
  minHeight: 44,
  minWidth: 44,
  padding: '0 var(--sp-3)',
  border: '1px solid var(--c-border)',
  borderRadius: 'var(--r-md)',
  background: 'var(--c-surface)',
  color: 'var(--c-text-2)',
  fontFamily: 'var(--font-ui)',
  fontSize: 14,
  fontWeight: 500,
  cursor: 'pointer',
  flexShrink: 0,
};

const overlayStatusStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--sp-1)',
  padding: '0 var(--sp-2) 0 var(--sp-4)',
  background: 'var(--c-surface)',
  border: '1px solid var(--c-border)',
  borderRadius: 'var(--r-full)',
  boxShadow: 'var(--shadow-sm)',
  fontFamily: 'var(--font-ui)',
  fontSize: 13,
  color: 'var(--c-text-2)',
  whiteSpace: 'nowrap',
};

const clearButtonStyle: React.CSSProperties = {
  ...linkStyle,
  minWidth: 44,
  justifyContent: 'center',
  padding: '0 var(--sp-2)',
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
};

const btnStyle: React.CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: '50%',
  background: 'transparent',
  border: '1px solid rgba(140,200,140,0.22)',
  color: '#b8d4b8',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
  fontSize: 16,
  lineHeight: 1,
  padding: 0,
  transition: 'background 0.15s, color 0.15s',
  flexShrink: 0,
};

const divider = (
  <div style={{ width: 1, height: 18, background: 'rgba(100,160,100,0.2)', margin: '0 6px' }} />
);

export default function CanvasToolbar({
  scale, onZoomIn, onZoomOut, onResetZoom,
  gardens, activeGardenId, onGardenChange,
  mode, onModeChange,
  panActive, onPanToggle,
  bedManagerOpen, onBedManagerToggle,
  conflictCount,
  onJumpToConflict,
  currentSeason, earlierSeasons, overlaySeason, overlayStatus, onOverlaySeasonChange,
}: Props) {
  const isMobile = useIsMobile();
  const pct = Math.round(scale * 100);

  // Hidden when there is nothing earlier to overlay (unless one is showing,
  // e.g. turned on programmatically for a season not yet in the list).
  const seasonOptions = overlaySeason != null && !earlierSeasons.includes(overlaySeason)
    ? [...earlierSeasons, overlaySeason].sort((a, b) => b - a)
    : earlierSeasons;
  const showSeasonSelect = seasonOptions.length > 0;

  const seasonSelect = showSeasonSelect && (
    <select
      aria-label="Season overlay"
      value={overlaySeason ?? 'current'}
      onChange={e => onOverlaySeasonChange(e.target.value === 'current' ? null : Number(e.target.value))}
      style={seasonSelectStyle}
    >
      <option value="current">This season ({currentSeason})</option>
      {seasonOptions.map(s => (
        <option key={s} value={s}>{s}</option>
      ))}
    </select>
  );

  const overlayStatusText = overlaySeason == null ? null
    : overlayStatus === 'empty' ? `No canvas layout found for ${overlaySeason}.`
    : overlayStatus === 'error' ? `Couldn’t load the ${overlaySeason} layout.`
    : overlayStatus === 'loading' ? `Loading ${overlaySeason} overlay…`
    : `Showing ${overlaySeason} overlay`;

  const overlayStatusPill = overlayStatusText && (
    <div style={overlayStatusStyle}>
      <span role="status">{overlayStatusText}</span>
      <span aria-hidden="true">·</span>
      <button type="button" onClick={() => onOverlaySeasonChange(null)} style={clearButtonStyle}>
        Clear
      </button>
    </div>
  );

  // Mobile: the toolbar pill is already near full width, so the select moves
  // to the row above it, next to the overlay status.
  const statusRow = (isMobile ? (showSeasonSelect || overlayStatusPill) : overlayStatusPill) && (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap',
      gap: 'var(--sp-2)', maxWidth: 'calc(100vw - 2 * var(--sp-4))', pointerEvents: 'auto',
    }}>
      {isMobile && seasonSelect}
      {overlayStatusPill}
    </div>
  );

  const modeBtn = (m: CanvasMode, label: string) => (
    <button
      onClick={() => onModeChange(m)}
      title={`${label} bed mode`}
      style={{
        padding: '3px 10px',
        borderRadius: 999,
        fontSize: 11,
        fontFamily: "'DM Mono', 'Courier New', monospace",
        cursor: 'pointer',
        border: '1px solid',
        transition: 'all 0.15s',
        ...(mode === m
          ? { background: 'rgba(140,200,140,0.18)', borderColor: 'rgba(140,200,140,0.4)', color: '#c8e8c8' }
          : { background: 'transparent', borderColor: 'transparent', color: '#7a9e7a' }),
      }}
    >
      {label}
    </button>
  );

  const iconBtn = (icon: string, label: string, active: boolean, onClick: () => void) => (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      style={{
        ...btnStyle,
        background: active ? 'rgba(140,200,140,0.18)' : 'transparent',
        borderColor: active ? 'rgba(140,200,140,0.4)' : 'rgba(140,200,140,0.22)',
        color: active ? '#c8e8c8' : '#b8d4b8',
        fontSize: 14,
      }}
    >
      {icon}
    </button>
  );

  return (
    <div style={{
      position: 'fixed',
      bottom: 'calc(24px + var(--shell-bottom, 0px) + var(--deletion-banner-h, 0px))',
      left: '50%',
      transform: 'translateX(-50%)',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 'var(--sp-2)',
      zIndex: 10,
      pointerEvents: 'none',
    }}>
      {statusRow}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        background: 'rgba(16, 34, 22, 0.88)',
        backdropFilter: 'blur(14px)',
        WebkitBackdropFilter: 'blur(14px)',
        border: '1px solid rgba(100,160,100,0.18)',
        borderRadius: 999,
        padding: '5px 10px',
        boxShadow: '0 8px 32px rgba(0,0,0,0.28), 0 1px 0 rgba(100,160,100,0.12) inset',
        userSelect: 'none',
        pointerEvents: 'auto',
      }}>
        {/* Mode switcher */}
        {modeBtn('grid', 'Grid')}
        {modeBtn('freeform', 'Freeform')}

        {divider}

        {/* Pan tool */}
        {iconBtn('✋', 'Pan tool (or hold Space)', panActive, onPanToggle)}

        {/* Beds manager */}
        {iconBtn('☰', 'Bed manager', bedManagerOpen, onBedManagerToggle)}

        {divider}

        {/* Zoom */}
        <button style={btnStyle} onClick={onZoomOut} aria-label="Zoom out">−</button>
        <button
          onClick={onResetZoom}
          aria-label="Reset zoom to 100%"
          title="Click to reset zoom"
          style={{
            fontFamily: "'DM Mono', 'Courier New', monospace",
            fontSize: 11,
            color: '#c0d8c0',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            minWidth: 44,
            textAlign: 'center',
            padding: '0 4px',
            letterSpacing: '0.03em',
          }}
        >
          {pct}%
        </button>
        <button style={btnStyle} onClick={onZoomIn} aria-label="Zoom in">+</button>

        {/* Garden switcher */}
        {gardens.length > 1 && (
          <>
            {divider}
            <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
              {gardens.map(g => (
                <button
                  key={g.id}
                  onClick={() => onGardenChange(g.id)}
                  title={g.name}
                  style={{
                    padding: '3px 10px',
                    borderRadius: 999,
                    fontSize: 11,
                    fontFamily: "'DM Mono', 'Courier New', monospace",
                    cursor: 'pointer',
                    border: '1px solid',
                    transition: 'all 0.15s',
                    ...(g.id === activeGardenId
                      ? { background: 'rgba(140,200,140,0.18)', borderColor: 'rgba(140,200,140,0.4)', color: '#c8e8c8' }
                      : { background: 'transparent', borderColor: 'transparent', color: '#7a9e7a' }),
                  }}
                >
                  {g.name.length > 14 ? g.name.slice(0, 13) + '…' : g.name}
                </button>
              ))}
            </div>
          </>
        )}

        {/* Companion conflict indicator */}
        {conflictCount != null && conflictCount > 0 && (
          <button
            onClick={onJumpToConflict}
            style={{
              padding: '5px 10px',
              borderRadius: 6,
              border: '1px solid #C88A2A',
              background: 'transparent',
              color: '#C88A2A',
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: 600,
              whiteSpace: 'nowrap',
            }}
          >
            {conflictCount} companion conflict{conflictCount === 1 ? '' : 's'}
          </button>
        )}

        {/* Season overlay (desktop: right end of the toolbar) */}
        {!isMobile && seasonSelect && (
          <>
            {divider}
            {/* 44px hit area without growing the pill (5px padding + 28px
                buttons): the negative margin lets the select overhang it. */}
            <div style={{ display: 'flex', margin: '-8px 0' }}>{seasonSelect}</div>
          </>
        )}
      </div>
    </div>
  );
}
