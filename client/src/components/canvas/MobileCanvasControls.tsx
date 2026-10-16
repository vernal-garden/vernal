import { useState } from 'react';
import type { CSSProperties } from 'react';
import BottomSheet from '../shell/BottomSheet';
import { DESKTOP_MESSAGES } from '../shell/BetterOnDesktop';
import { CloseIcon } from '../shell/icons';
import type { SeasonOverlayStatus } from './CanvasToolbar';

// Phase 53: the view-only mobile canvas chrome, rendered in place of the
// toolbar: a quiet editing note, a season pill (opens a sheet driving the
// past-season overlay) and zoom buttons.

const NOTE_DISMISS_KEY = 'vernal.canvas.mobileNote';

function readNoteDismissed(): boolean {
  try {
    return window.sessionStorage.getItem(NOTE_DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

function writeNoteDismissed(): void {
  try {
    window.sessionStorage.setItem(NOTE_DISMISS_KEY, '1');
  } catch {
    // Storage unavailable: the in-memory dismissal still hides the note.
  }
}

const surfaceStyle: CSSProperties = {
  background: 'var(--c-surface)',
  border: '1px solid var(--c-border)',
  boxShadow: 'var(--shadow-md)',
  fontFamily: 'var(--font-ui)',
};

const zoomButtonStyle: CSSProperties = {
  ...surfaceStyle,
  width: 44,
  height: 44,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
  borderRadius: 'var(--r-full)',
  color: 'var(--c-text)',
  fontSize: 22,
  lineHeight: 1,
  cursor: 'pointer',
};

interface Props {
  currentSeason: number;
  earlierSeasons: number[];
  overlaySeason: number | null;
  overlayStatus: SeasonOverlayStatus;
  onOverlaySeasonChange: (season: number | null) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
}

export default function MobileCanvasControls({
  currentSeason, earlierSeasons, overlaySeason, overlayStatus, onOverlaySeasonChange,
  onZoomIn, onZoomOut,
}: Props) {
  const [noteDismissed, setNoteDismissed] = useState(readNoteDismissed);
  const [sheetOpen, setSheetOpen] = useState(false);

  // Same list as the desktop select: earlier layout seasons, plus a showing
  // season that is not (yet) in it.
  const seasonOptions = overlaySeason != null && !earlierSeasons.includes(overlaySeason)
    ? [...earlierSeasons, overlaySeason].sort((a, b) => b - a)
    : earlierSeasons;

  const pillText = overlaySeason == null ? 'This season' : `${overlaySeason} overlay`;

  const statusText = overlaySeason == null ? null
    : overlayStatus === 'empty' ? `No canvas layout found for ${overlaySeason}.`
    : overlayStatus === 'error' ? `Couldn’t load the ${overlaySeason} layout.`
    : overlayStatus === 'loading' ? `Loading ${overlaySeason} overlay…`
    : null;

  const dismissNote = () => {
    writeNoteDismissed();
    setNoteDismissed(true);
  };

  const choose = (season: number | null) => {
    onOverlaySeasonChange(season);
    setSheetOpen(false);
  };

  const option = (season: number | null, label: string) => {
    const selected = overlaySeason === season;
    return (
      <li key={season ?? 'current'}>
        <button
          type="button"
          aria-pressed={selected}
          onClick={() => choose(season)}
          style={{
            width: '100%',
            minHeight: 48,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 'var(--sp-2)',
            padding: '0 var(--sp-4)',
            border: 'none',
            borderBottom: '1px solid var(--c-border-subtle)',
            background: selected ? 'var(--c-primary-subtle)' : 'transparent',
            color: 'var(--c-text)',
            fontFamily: 'var(--font-ui)',
            fontSize: 15,
            fontWeight: selected ? 600 : 500,
            textAlign: 'left',
            cursor: 'pointer',
          }}
        >
          <span>{label}</span>
          {selected && <span aria-hidden="true" style={{ color: 'var(--c-primary)' }}>✓</span>}
        </button>
      </li>
    );
  };

  return (
    <>
      {/* Top: editing note (full width) with the season pill under its right end. */}
      <div style={{
        position: 'fixed',
        top: 'calc(var(--shell-top, 0px) + var(--sp-2))',
        left: 'var(--sp-3)',
        right: 'var(--sp-3)',
        zIndex: 10,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        gap: 'var(--sp-2)',
        pointerEvents: 'none',
      }}>
        {!noteDismissed && (
          <div
            role="note"
            aria-label="Editing note"
            style={{
              ...surfaceStyle,
              boxShadow: 'var(--shadow-sm)',
              width: '100%',
              boxSizing: 'border-box',
              display: 'flex',
              alignItems: 'flex-start',
              borderRadius: 'var(--r-md)',
              pointerEvents: 'auto',
            }}
          >
            <p style={{
              flex: 1,
              minWidth: 0,
              margin: 0,
              padding: 'var(--sp-2) 0 var(--sp-2) var(--sp-3)',
              fontSize: 13,
              lineHeight: 1.45,
              color: 'var(--c-text-2)',
            }}>
              {DESKTOP_MESSAGES.canvasEditing}
            </p>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={dismissNote}
              style={{
                width: 44,
                height: 44,
                flexShrink: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 0,
                border: 'none',
                borderRadius: 'var(--r-md)',
                background: 'transparent',
                color: 'var(--c-text-3)',
                cursor: 'pointer',
              }}
            >
              <CloseIcon width={18} height={18} />
            </button>
          </div>
        )}

        <button
          type="button"
          aria-label={`Season: ${pillText}`}
          aria-haspopup="dialog"
          aria-expanded={sheetOpen}
          onClick={() => setSheetOpen(true)}
          style={{
            ...surfaceStyle,
            minHeight: 44,
            minWidth: 44,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 'var(--sp-2)',
            padding: '0 var(--sp-4)',
            borderRadius: 'var(--r-full)',
            color: overlaySeason == null ? 'var(--c-text)' : 'var(--c-primary)',
            fontSize: 14,
            fontWeight: 600,
            whiteSpace: 'nowrap',
            cursor: 'pointer',
            pointerEvents: 'auto',
          }}
        >
          {pillText}
          <span aria-hidden="true" style={{ fontSize: 11, color: 'var(--c-text-3)' }}>▾</span>
        </button>

        {statusText && (
          <div
            role="status"
            style={{
              ...surfaceStyle,
              boxShadow: 'var(--shadow-sm)',
              maxWidth: '100%',
              padding: 'var(--sp-1) var(--sp-3)',
              borderRadius: 'var(--r-full)',
              fontSize: 12,
              color: overlayStatus === 'error' ? 'var(--c-danger)' : 'var(--c-text-2)',
            }}
          >
            {statusText}
          </div>
        )}
      </div>

      <BottomSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title="Season"
        ariaLabel="Choose season"
      >
        <ul style={{ listStyle: 'none', margin: 0, padding: '0 0 var(--sp-4)' }}>
          {option(null, `This season (${currentSeason})`)}
          {seasonOptions.map(s => option(s, `${s} overlay`))}
        </ul>
      </BottomSheet>

      {/* Zoom, bottom right: clear of the tab bar and of the feedback button
          (which sits bottom left while the canvas is mounted). */}
      <div style={{
        position: 'fixed',
        right: 'var(--sp-4)',
        bottom: 'calc(var(--shell-bottom, 0px) + var(--sp-4))',
        zIndex: 10,
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--sp-2)',
      }}>
        <button type="button" aria-label="Zoom in" onClick={onZoomIn} style={zoomButtonStyle}>
          <span aria-hidden="true">+</span>
        </button>
        <button type="button" aria-label="Zoom out" onClick={onZoomOut} style={zoomButtonStyle}>
          <span aria-hidden="true">−</span>
        </button>
      </div>
    </>
  );
}
