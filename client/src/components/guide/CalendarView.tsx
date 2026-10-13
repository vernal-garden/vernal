import { useRef, useState } from 'react';
import type { GuideRow } from '../../types/plantingGuide';
import { addDays, monthFraction, MONTH_SHORT, parseDay } from '../../lib/guideDates';
import { assignLanes, placeholderSpan, rowKey, rowWindows } from '../../lib/guideModel';
import RowLabel from './RowLabel';
import WindowBar, { type BarKind } from './WindowBar';
import { iconButtonStyle } from './styles';
import { gardenOf, type GuideViewProps } from './viewTypes';

const BAR_HEIGHT = 14;
const LANE_GAP = 4;
const SWIPE_THRESHOLD_PX = 50;

// Months from Jan 1 of the season; dates in other years land outside 0..12.
function monthPos(key: string, season: number): number {
  const { y } = parseDay(key);
  const { monthIndex, fraction } = monthFraction(key);
  return (y - season) * 12 + monthIndex + fraction;
}

interface Bar {
  kind: BarKind;
  start: string;
  end: string;
}

function barsFor(row: GuideRow, props: GuideViewProps): Bar[] {
  const windows = rowWindows(row);
  if (windows.length > 0) return windows.map(({ kind, window }) => ({ kind, start: window.start, end: window.end }));
  return [{ kind: 'none', ...placeholderSpan(gardenOf(props.gardens, row), props.season) }];
}

export default function CalendarView(props: GuideViewProps) {
  const { rows, season, isCurrentSeason, today, showGardenName, isMobile, onOpen, gardens } = props;
  const currentMonth = parseDay(today).m - 1;
  const monthCount = isMobile ? 3 : 12;
  const maxFirst = 12 - monthCount;
  const [mobileFirst, setMobileFirst] = useState(() => Math.min(Math.max(currentMonth - 1, 0), 9));
  const first = isMobile ? mobileFirst : 0;
  const months = Array.from({ length: monthCount }, (_, i) => first + i);
  const labelWidth = isMobile ? 112 : 220;

  const swipeRef = useRef<{ id: number; x: number } | null>(null);
  // A swipe that ends on a row must not also open that row's schedule.
  const swipedRef = useRef(false);

  function shift(delta: number) {
    setMobileFirst((f) => Math.min(Math.max(f + delta, 0), maxFirst));
  }

  const tinted = (m: number) => isCurrentSeason && m === currentMonth;

  return (
    <div
      onPointerDown={isMobile ? (e) => { swipeRef.current = { id: e.pointerId, x: e.clientX }; swipedRef.current = false; } : undefined}
      onPointerUp={
        isMobile
          ? (e) => {
              const start = swipeRef.current;
              swipeRef.current = null;
              if (!start || start.id !== e.pointerId) return;
              const dx = e.clientX - start.x;
              if (Math.abs(dx) < SWIPE_THRESHOLD_PX) return;
              swipedRef.current = true;
              shift(dx < 0 ? 1 : -1);
            }
          : undefined
      }
      onClickCapture={(e) => {
        if (!swipedRef.current) return;
        swipedRef.current = false;
        e.stopPropagation();
      }}
      onPointerCancel={() => { swipeRef.current = null; }}
      style={{ touchAction: isMobile ? 'pan-y' : undefined, minWidth: 0 }}
    >
      {isMobile && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--sp-2)' }}>
          <button type="button" aria-label="Previous month" disabled={first === 0} onClick={() => shift(-1)} style={{ ...iconButtonStyle, opacity: first === 0 ? 0.4 : 1 }}>
            ‹
          </button>
          <span style={{ fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--c-text-3)' }}>
            {MONTH_SHORT[first]} – {MONTH_SHORT[first + monthCount - 1]} {season}
          </span>
          <button type="button" aria-label="Next month" disabled={first === maxFirst} onClick={() => shift(1)} style={{ ...iconButtonStyle, opacity: first === maxFirst ? 0.4 : 1 }}>
            ›
          </button>
        </div>
      )}

      {/* Sticky month headers */}
      <div
        style={{
          position: 'sticky',
          top: 'var(--shell-top, 0px)',
          zIndex: 2,
          display: 'grid',
          gridTemplateColumns: `${labelWidth}px 1fr`,
          background: 'var(--c-bg)',
          borderBottom: '1px solid var(--c-border)',
        }}
      >
        <div />
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${monthCount}, 1fr)` }}>
          {months.map((m) => (
            <div
              key={m}
              data-testid="calendar-month"
              aria-current={tinted(m) ? 'date' : undefined}
              style={{
                padding: 'var(--sp-2) 0',
                textAlign: 'center',
                fontFamily: 'var(--font-ui)',
                fontSize: 12,
                fontWeight: 600,
                color: tinted(m) ? 'var(--c-primary-dark)' : 'var(--c-text-2)',
                background: tinted(m) ? 'var(--c-primary-subtle)' : undefined,
                borderLeft: '1px solid var(--c-border-subtle)',
              }}
            >
              {MONTH_SHORT[m]}
            </div>
          ))}
        </div>
      </div>

      {rows.map((row) => {
        const lanes = assignLanes(barsFor(row, props));
        const laneCount = Math.max(1, ...lanes.map((l) => l.lane + 1));
        const trackHeight = laneCount * BAR_HEIGHT + (laneCount - 1) * LANE_GAP;
        const garden = gardenOf(gardens, row);
        return (
          <div
            key={rowKey(row)}
            onClick={() => onOpen(row)}
            style={{
              display: 'grid',
              gridTemplateColumns: `${labelWidth}px 1fr`,
              borderBottom: '1px solid var(--c-border-subtle)',
              cursor: 'pointer',
            }}
          >
            <button
              type="button"
              aria-label={`Open schedule for ${row.commonName ?? 'plant'}`}
              style={{
                minHeight: 44,
                minWidth: 0,
                padding: 'var(--sp-2) var(--sp-2) var(--sp-2) 0',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
              }}
            >
              <RowLabel row={row} gardenName={showGardenName ? garden?.name ?? null : null} compact={isMobile} />
            </button>
            <div style={{ position: 'relative', minHeight: Math.max(44, trackHeight + 16) }}>
              {months.map((m, i) => (
                <div
                  key={m}
                  aria-hidden="true"
                  style={{
                    position: 'absolute',
                    top: 0,
                    bottom: 0,
                    left: `${(i / monthCount) * 100}%`,
                    width: `${100 / monthCount}%`,
                    borderLeft: '1px solid var(--c-border-subtle)',
                    background: tinted(m) ? 'var(--c-primary-subtle)' : undefined,
                  }}
                />
              ))}
              {lanes.map(({ item: bar, lane }) => {
                const s = monthPos(bar.start, season);
                const e = monthPos(addDays(bar.end, 1), season);
                const visibleStart = Math.max(s, first);
                const visibleEnd = Math.min(e, first + monthCount);
                if (visibleEnd <= visibleStart) return null;
                return (
                  <WindowBar
                    key={`${bar.kind}-${bar.start}`}
                    kind={bar.kind}
                    start={bar.start}
                    end={bar.end}
                    roundStart={s >= first}
                    roundEnd={e <= first + monthCount}
                    style={{
                      position: 'absolute',
                      top: `calc(50% - ${trackHeight / 2}px + ${lane * (BAR_HEIGHT + LANE_GAP)}px)`,
                      height: BAR_HEIGHT,
                      left: `${((visibleStart - first) / monthCount) * 100}%`,
                      width: `${((visibleEnd - visibleStart) / monthCount) * 100}%`,
                      minWidth: 6,
                    }}
                  />
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
