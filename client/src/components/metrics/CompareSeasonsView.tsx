import { Fragment, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import { formatQuantity } from '../../hooks/useHarvests';
import type { CrossSeasonResponse, CrossSeasonSeason } from '../../types/metrics';
import {
  bodyTextStyle,
  cardStyle,
  dotStyle,
  harvestLinkFor,
  linkStyle,
  listStyle,
  plural,
  secondaryTextStyle,
  segmentGroupStyle,
  segmentStyle,
  shortDate,
  subheadingStyle,
} from './styles';

// The comparison itself: a chart (default) or table of the server's season
// figures, and the chosen season's entries below. Nothing is totalled here.

// Bar / swatch colour by the season's position in the comparison (at most 4).
// The year is always written beside the colour.
export const SEASON_COLORS = ['var(--c-primary)', 'var(--c-secondary)', 'var(--c-info)', 'var(--c-warning)'];

type CompareView = 'chart' | 'table';
const VIEW_KEY = 'vernal.metrics.compareView';

function readView(): CompareView {
  try {
    return window.sessionStorage.getItem(VIEW_KEY) === 'table' ? 'table' : 'chart';
  } catch {
    return 'chart';
  }
}

function storeView(view: CompareView): void {
  try {
    window.sessionStorage.setItem(VIEW_KEY, view);
  } catch {
    // storage unavailable — the choice lasts for this page view only
  }
}

function seasonLabel(s: CrossSeasonSeason, unit: CrossSeasonResponse['unit']): string {
  const amount = formatQuantity(s.total, unit) ?? plural(s.entryCount, 'harvest', 'harvests');
  return `${s.season} · ${amount}`;
}

function sowingLine(s: CrossSeasonSeason): string | null {
  if (!s.sowing) return null;
  // ED: replace with final copy
  const sowed = `Sowed ${shortDate(s.sowing.sowDate)}`;
  return s.sowing.daysToFirstHarvest === null
    ? sowed
    : `${sowed} — ${plural(s.sowing.daysToFirstHarvest, 'day', 'days')} to first harvest`;
}

function SowingNote({ season }: { season: CrossSeasonSeason }) {
  const line = sowingLine(season);
  if (!line) return null;
  return (
    <span style={{ display: 'block', ...secondaryTextStyle }}>
      {line}
      {/* ED: replace with final copy */}
      {season.sowing?.sowDateSource === 'marked_done' && ' (based on when you marked it done)'}
    </span>
  );
}

interface Props {
  data: CrossSeasonResponse;
  isMobile: boolean;
  // A filter change is loading: the old figures stay on screen, dimmed.
  refreshing: boolean;
}

export default function CompareSeasonsView({ data, isMobile, refreshing }: Props) {
  const [view, setView] = useState<CompareView>(readView);
  const [openSeason, setOpenSeason] = useState<number | null>(null);

  function changeView(next: CompareView) {
    setView(next);
    storeView(next);
  }

  function toggle(season: number) {
    setOpenSeason((cur) => (cur === season ? null : season));
  }

  const seasons = data.seasons;
  const colorOf = (i: number) => SEASON_COLORS[i % SEASON_COLORS.length];
  const open = seasons.find((s) => s.season === openSeason) ?? null;
  const openIndex = open ? seasons.indexOf(open) : -1;
  const predicted = seasons.find((s) => s.predicted !== null)?.predicted ?? null;
  const hasQuantities = data.unit !== null && seasons.some((s) => s.total !== null);

  const chartRows = seasons.map((s) => ({ label: seasonLabel(s, data.unit), total: s.total ?? 0 }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)', minWidth: 0 }}>
      <section
        aria-labelledby="compare-seasons-title"
        aria-busy={refreshing}
        style={{ ...cardStyle, opacity: refreshing ? 0.6 : 1, transition: 'opacity 150ms' }}
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--sp-2)' }}>
          {/* ED: replace with final copy */}
          <h2 id="compare-seasons-title" style={subheadingStyle}>Season by season</h2>
          <div
            role="group"
            // ED: replace with final copy
            aria-label="Show comparison as"
            style={segmentGroupStyle}
          >
            <button type="button" aria-pressed={view === 'chart'} onClick={() => changeView('chart')} style={segmentStyle(view === 'chart')}>
              Chart
            </button>
            <button type="button" aria-pressed={view === 'table'} onClick={() => changeView('table')} style={segmentStyle(view === 'table')}>
              Table
            </button>
          </div>
        </div>

        {view === 'chart' ? (
          <>
            {hasQuantities ? (
              // The buttons below carry the same figures for keyboard and
              // screen-reader users, so the chart itself is hidden from them.
              <div aria-hidden="true">
                <ResponsiveContainer width="100%" height={chartRows.length * 52 + 16}>
                  <BarChart
                    data={chartRows}
                    layout="vertical"
                    accessibilityLayer={false}
                    margin={{ top: 4, right: 16, bottom: 4, left: 0 }}
                  >
                    <CartesianGrid stroke="var(--c-border-subtle)" horizontal={false} />
                    <XAxis type="number" hide />
                    <YAxis
                      type="category"
                      dataKey="label"
                      width={isMobile ? 120 : 160}
                      tick={{ fontFamily: 'var(--font-ui)', fontSize: 12, fill: 'var(--c-text-2)' }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <Bar
                      dataKey="total"
                      radius={[0, 3, 3, 0]}
                      barSize={28}
                      cursor="pointer"
                      onClick={(_, index) => {
                        const s = seasons[index];
                        if (s) toggle(s.season);
                      }}
                    >
                      {seasons.map((s, i) => (
                        <Cell
                          key={s.season}
                          fill={colorOf(i)}
                          fillOpacity={openSeason === null || openSeason === s.season ? 1 : 0.45}
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : (
              // ED: replace with final copy
              <p style={bodyTextStyle}>No quantities recorded for this plant in these seasons.</p>
            )}

            <ul style={{ ...listStyle, gap: 'var(--sp-1)' }}>
              {seasons.map((s, i) => (
                <li key={s.season}>
                  <button
                    type="button"
                    aria-expanded={openSeason === s.season}
                    aria-controls="compare-season-entries"
                    onClick={() => toggle(s.season)}
                    style={seasonButtonStyle(openSeason === s.season)}
                  >
                    <span aria-hidden="true" style={{ ...dotStyle(colorOf(i)), marginTop: 5 }} />
                    <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, textAlign: 'left' }}>
                      <span style={{ fontWeight: 600, color: 'var(--c-text)' }}>{seasonLabel(s, data.unit)}</span>
                      {s.mixedUnits && <span style={secondaryTextStyle}>mixed units — see log for details</span>}
                      <SowingNote season={s} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <div style={{ overflowX: 'auto', margin: '0 calc(-1 * var(--sp-2))' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14, color: 'var(--c-text)', fontVariantNumeric: 'tabular-nums' }}>
              <thead>
                <tr>
                  <th scope="col" style={thStyle}>Season</th>
                  <th scope="col" style={thStyle}>Total</th>
                  <th scope="col" style={thStyle}>Harvests</th>
                  <th scope="col" style={thStyle}>First</th>
                  <th scope="col" style={thStyle}>Last</th>
                  <th scope="col" style={thStyle}>Avg days between</th>
                  <th scope="col" style={thStyle}>
                    {predicted ? `Days to first harvest (vs ${predicted.min}–${predicted.max})` : 'Days to first harvest'}
                  </th>
                </tr>
              </thead>
              <tbody>
                {seasons.map((s, i) => {
                  const line = sowingLine(s);
                  const isOpen = openSeason === s.season;
                  return (
                    <Fragment key={s.season}>
                      <tr
                        onClick={() => toggle(s.season)}
                        style={{ cursor: 'pointer', background: isOpen ? 'var(--c-primary-subtle)' : 'transparent' }}
                      >
                        <th scope="row" style={{ ...tdStyle, padding: 0 }}>
                          <button
                            type="button"
                            aria-expanded={isOpen}
                            aria-controls="compare-season-entries"
                            onClick={(e) => {
                              e.stopPropagation();
                              toggle(s.season);
                            }}
                            style={rowButtonStyle}
                          >
                            <span aria-hidden="true" style={dotStyle(colorOf(i))} />
                            {s.season}
                          </button>
                        </th>
                        <td style={tdStyle}>
                          {formatQuantity(s.total, data.unit) ?? '—'}
                          {/* ED: replace with final copy */}
                          {s.mixedUnits && <span style={{ display: 'block', ...secondaryTextStyle }}>mixed units</span>}
                        </td>
                        <td style={tdStyle}>{s.entryCount}</td>
                        <td style={tdStyle}>{s.firstDate ? shortDate(s.firstDate) : '—'}</td>
                        <td style={tdStyle}>{s.lastDate ? shortDate(s.lastDate) : '—'}</td>
                        <td style={tdStyle}>{s.avgDaysBetween ?? '—'}</td>
                        <td style={tdStyle}>{s.sowing?.daysToFirstHarvest ?? '—'}</td>
                      </tr>
                      {line && (
                        <tr
                          onClick={() => toggle(s.season)}
                          style={{ cursor: 'pointer', background: isOpen ? 'var(--c-primary-subtle)' : 'transparent' }}
                        >
                          <td colSpan={7} style={{ ...tdStyle, paddingTop: 0 }}>
                            <SowingNote season={s} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div id="compare-season-entries">
        {open && (
          <section aria-labelledby="compare-entries-title" style={cardStyle}>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--sp-2)' }}>
              <h2 id="compare-entries-title" style={{ ...subheadingStyle, display: 'flex', alignItems: 'center', gap: 'var(--sp-2)' }}>
                <span aria-hidden="true" style={dotStyle(colorOf(openIndex))} />
                {/* ED: replace with final copy */}
                {open.season} harvests
              </h2>
              {(() => {
                const href = harvestLinkFor(data.plant, open.season);
                return href ? <Link to={href} style={linkStyle}>View in harvest log</Link> : null;
              })()}
            </div>
            {open.entries.length === 0 ? (
              // ED: replace with final copy
              <p style={bodyTextStyle}>No harvests logged this season with these filters.</p>
            ) : (
              <ul style={listStyle}>
                {open.entries.map((e) => {
                  const qty = formatQuantity(e.quantity, e.unit);
                  return (
                    <li
                      key={e.id}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 2,
                        padding: 'var(--sp-2) 0',
                        borderBottom: '1px solid var(--c-border-subtle)',
                        fontSize: 14,
                      }}
                    >
                      <span style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--sp-2)', color: 'var(--c-text)' }}>
                        <span style={{ fontWeight: 600 }}>{shortDate(e.harvestDate)}</span>
                        {qty && <span style={{ fontVariantNumeric: 'tabular-nums' }}>{qty}</span>}
                        {e.bedLabel && <span style={{ color: 'var(--c-text-2)' }}>{e.bedLabel}</span>}
                      </span>
                      {e.notesExcerpt && (
                        <span style={{ ...secondaryTextStyle, overflowWrap: 'anywhere' }}>{e.notesExcerpt}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

function seasonButtonStyle(active: boolean): CSSProperties {
  return {
    width: '100%',
    minHeight: 44,
    display: 'flex',
    alignItems: 'flex-start',
    gap: 'var(--sp-3)',
    padding: 'var(--sp-2) var(--sp-3)',
    background: active ? 'var(--c-primary-subtle)' : 'transparent',
    border: `1px solid ${active ? 'var(--c-primary-light)' : 'transparent'}`,
    borderRadius: 'var(--r-md)',
    fontFamily: 'var(--font-ui)',
    fontSize: 14,
    cursor: 'pointer',
    boxSizing: 'border-box',
  };
}

const rowButtonStyle: CSSProperties = {
  minHeight: 44,
  minWidth: 44,
  width: '100%',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 'var(--sp-2)',
  padding: '0 var(--sp-2)',
  background: 'transparent',
  border: 'none',
  fontFamily: 'var(--font-ui)',
  fontSize: 14,
  fontWeight: 600,
  color: 'var(--c-text)',
  cursor: 'pointer',
  textAlign: 'left',
};

const thStyle: CSSProperties = {
  textAlign: 'left',
  padding: 'var(--sp-2)',
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--c-text-3)',
  borderBottom: '1px solid var(--c-border)',
  verticalAlign: 'bottom',
};

const tdStyle: CSSProperties = {
  textAlign: 'left',
  padding: 'var(--sp-2)',
  borderBottom: '1px solid var(--c-border-subtle)',
  verticalAlign: 'middle',
  whiteSpace: 'nowrap',
};
