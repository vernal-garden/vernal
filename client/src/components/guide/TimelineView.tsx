import { useLayoutEffect, useRef, useState } from 'react';
import type { GuideRow } from '../../types/plantingGuide';
import {
  addDays, daysBetween, daysInYear, formatRange, MONTH_LONG, MONTH_SHORT, monthEnd, monthStart, parseDay, toKey,
} from '../../lib/guideDates';
import { assignLanes, overlaps, placeholderSpan, rowKey, rowWindows, WINDOW_NAMES } from '../../lib/guideModel';
import RowLabel from './RowLabel';
import WindowBar, { type BarKind } from './WindowBar';
import { segmentStyle } from './styles';
import { gardenOf, type GuideViewProps } from './viewTypes';

const PX_PER_DAY = 4;
const LABEL_WIDTH = 220;
const BAR_HEIGHT = 14;
const LANE_GAP = 4;

interface Bar {
  kind: BarKind;
  start: string;
  end: string;
}

export default function TimelineView(props: GuideViewProps) {
  return props.isMobile ? <MobileTimeline {...props} /> : <DesktopTimeline {...props} />;
}

// ── Desktop: horizontal Gantt ─────────────────────────────────────────────────

function DesktopTimeline(props: GuideViewProps) {
  const { rows, gardens, season, isCurrentSeason, today, showGardenName, onOpen } = props;
  const [weekLines, setWeekLines] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  const yearStart = toKey(season, 1, 1);
  const totalDays = daysInYear(season);
  const trackWidth = totalDays * PX_PER_DAY;
  const x = (key: string) => daysBetween(yearStart, key) * PX_PER_DAY;
  const currentMonth = parseDay(today).m;

  // Bring the current month into view on mount.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = Math.max(0, x(monthStart(season, currentMonth)) - PX_PER_DAY * 7);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const monthStarts = Array.from({ length: 12 }, (_, i) => monthStart(season, i + 1));
  // Week lines fall on Mondays.
  const firstMonday = (8 - new Date(Date.UTC(season, 0, 1)).getUTCDay()) % 7;
  const weekOffsets: number[] = [];
  for (let d = firstMonday; d < totalDays; d += 7) weekOffsets.push(d);

  function barsFor(row: GuideRow): Bar[] {
    const windows = rowWindows(row);
    if (windows.length > 0) return windows.map(({ kind, window }) => ({ kind, start: window.start, end: window.end }));
    return [{ kind: 'none', ...placeholderSpan(gardenOf(gardens, row), season) }];
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 'var(--sp-2)' }}>
        <button
          type="button"
          aria-pressed={weekLines}
          onClick={() => setWeekLines((w) => !w)}
          style={{ ...segmentStyle(weekLines), border: '1px solid var(--c-border)', borderRadius: 'var(--r-md)' }}
        >
          Week lines
        </button>
      </div>
      <div
        ref={scrollRef}
        style={{ overflowX: 'auto', border: '1px solid var(--c-border-subtle)', borderRadius: 'var(--r-md)', background: 'var(--c-surface)' }}
      >
        <div style={{ position: 'relative', width: LABEL_WIDTH + trackWidth }}>
          {/* Grid lines and today line, behind the rows */}
          <div aria-hidden="true" style={{ position: 'absolute', top: 0, bottom: 0, left: LABEL_WIDTH, width: trackWidth, pointerEvents: 'none' }}>
            {weekLines && weekOffsets.map((d) => (
              <div key={`w${d}`} style={{ position: 'absolute', top: 0, bottom: 0, left: d * PX_PER_DAY, borderLeft: '1px solid var(--c-border-subtle)' }} />
            ))}
            {monthStarts.map((m) => (
              <div key={m} style={{ position: 'absolute', top: 0, bottom: 0, left: x(m), borderLeft: '1px solid var(--c-border)' }} />
            ))}
            {isCurrentSeason && (
              <div
                data-testid="timeline-today"
                style={{ position: 'absolute', top: 0, bottom: 0, left: x(today), width: 2, background: 'var(--c-primary)', opacity: 0.4 }}
              />
            )}
          </div>

          {/* Month labels */}
          <div style={{ display: 'flex', position: 'relative', borderBottom: '1px solid var(--c-border)' }}>
            <div style={{ position: 'sticky', left: 0, zIndex: 2, width: LABEL_WIDTH, flexShrink: 0, background: 'var(--c-surface)' }} />
            <div style={{ position: 'relative', width: trackWidth, height: 36 }}>
              {monthStarts.map((m, i) => (
                <div
                  key={m}
                  style={{
                    position: 'absolute',
                    left: x(m) + 6,
                    top: 0,
                    lineHeight: '36px',
                    fontFamily: 'var(--font-ui)',
                    fontSize: 13,
                    fontWeight: 700,
                    color: 'var(--c-text)',
                  }}
                >
                  {MONTH_SHORT[i]}
                </div>
              ))}
            </div>
          </div>

          {rows.map((row) => {
            const lanes = assignLanes(barsFor(row));
            const laneCount = Math.max(1, ...lanes.map((l) => l.lane + 1));
            const trackHeight = laneCount * BAR_HEIGHT + (laneCount - 1) * LANE_GAP;
            const garden = gardenOf(gardens, row);
            return (
              <div
                key={rowKey(row)}
                onClick={() => onOpen(row)}
                style={{ display: 'flex', position: 'relative', borderBottom: '1px solid var(--c-border-subtle)', cursor: 'pointer' }}
              >
                <button
                  type="button"
                  aria-label={`Open schedule for ${row.commonName ?? 'plant'}`}
                  style={{
                    position: 'sticky',
                    left: 0,
                    zIndex: 2,
                    width: LABEL_WIDTH,
                    flexShrink: 0,
                    minHeight: 44,
                    padding: 'var(--sp-2) var(--sp-3)',
                    background: 'var(--c-surface)',
                    border: 'none',
                    borderRight: '1px solid var(--c-border-subtle)',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                  }}
                >
                  <RowLabel row={row} gardenName={showGardenName ? garden?.name ?? null : null} />
                </button>
                <div style={{ position: 'relative', width: trackWidth, minHeight: Math.max(44, trackHeight + 16) }}>
                  {lanes.map(({ item: bar, lane }) => {
                    const s = x(bar.start);
                    const e = x(addDays(bar.end, 1));
                    const left = Math.max(0, s);
                    const right = Math.min(trackWidth, e);
                    if (right <= left) return null;
                    return (
                      <WindowBar
                        key={`${bar.kind}-${bar.start}`}
                        kind={bar.kind}
                        start={bar.start}
                        end={bar.end}
                        roundStart={s >= 0}
                        roundEnd={e <= trackWidth}
                        style={{
                          position: 'absolute',
                          top: `calc(50% - ${trackHeight / 2}px + ${lane * (BAR_HEIGHT + LANE_GAP)}px)`,
                          height: BAR_HEIGHT,
                          left,
                          width: Math.max(6, right - left),
                        }}
                      />
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Mobile: one section per month ─────────────────────────────────────────────

function MobileTimeline({ rows, season, showGardenName, gardens, onOpen }: GuideViewProps) {
  const sections = Array.from({ length: 12 }, (_, i) => i + 1)
    .map((m) => {
      const start = monthStart(season, m);
      const end = monthEnd(season, m);
      const entries = rows
        .map((row) => ({ row, windows: rowWindows(row).filter(({ window }) => overlaps(window, start, end)) }))
        .filter((e) => e.windows.length > 0);
      return { month: m, entries };
    })
    .filter((s) => s.entries.length > 0);

  if (sections.length === 0) {
    return (
      <p style={{ fontFamily: 'var(--font-ui)', fontSize: 14, color: 'var(--c-text-3)' }}>
        No planting windows to show for the current filters.
      </p>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-5)' }}>
      {sections.map(({ month, entries }) => (
        <section key={month} aria-label={MONTH_LONG[month - 1]}>
          <h2 style={{ margin: '0 0 var(--sp-2)', fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 600, color: 'var(--c-text)' }}>
            {MONTH_LONG[month - 1]}
          </h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}>
            {entries.map(({ row, windows }) => (
              <button
                key={rowKey(row)}
                type="button"
                onClick={() => onOpen(row)}
                style={{
                  minHeight: 44,
                  width: '100%',
                  padding: 'var(--sp-3)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 'var(--sp-2)',
                  textAlign: 'left',
                  background: 'var(--c-surface)',
                  border: '1px solid var(--c-border-subtle)',
                  borderRadius: 'var(--r-md)',
                  cursor: 'pointer',
                }}
              >
                <RowLabel row={row} gardenName={showGardenName ? gardenOf(gardens, row)?.name ?? null : null} />
                {windows.map(({ kind, window }) => (
                  <span key={kind} style={{ fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--c-text-2)' }}>
                    {WINDOW_NAMES[kind]}: {formatRange(window.start, window.end)}
                  </span>
                ))}
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
