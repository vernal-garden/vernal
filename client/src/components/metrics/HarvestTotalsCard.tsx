import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatQuantity } from '../../hooks/useHarvests';
import type { MetricsGarden, PlantTotal } from '../../types/metrics';
import type { HarvestUnit } from '../../types/harvest';
import {
  bodyTextStyle,
  cardStyle,
  cardTitleStyle,
  harvestLinkFor,
  linkStyle,
  listStyle,
  plantKeyOf,
  plantName,
  plural,
  rowLinkStyle,
  secondaryTextStyle,
  segmentGroupStyle,
  segmentStyle,
} from './styles';

type TotalsView = 'list' | 'chart';
const VIEW_KEY = 'vernal.metrics.totalsView';

function readView(): TotalsView {
  try {
    return window.sessionStorage.getItem(VIEW_KEY) === 'chart' ? 'chart' : 'list';
  } catch {
    return 'list';
  }
}

function storeView(view: TotalsView): void {
  try {
    window.sessionStorage.setItem(VIEW_KEY, view);
  } catch {
    // storage unavailable — the choice lasts for this page view only
  }
}

function unitWord(unit: HarvestUnit): string {
  return unit === 'count' ? 'items' : unit;
}

interface Props {
  totals: PlantTotal[];
  season: number;
  gardens: MetricsGarden[];
  gardenId: string | null;
  onGardenChange: (gardenId: string | null) => void;
  // A garden toggle is loading: the old totals stay on screen, dimmed.
  refreshing: boolean;
  isPastSeason: boolean;
}

export default function HarvestTotalsCard({ totals, season, gardens, gardenId, onGardenChange, refreshing, isPastSeason }: Props) {
  const [view, setView] = useState<TotalsView>(readView);

  function changeView(next: TotalsView) {
    setView(next);
    storeView(next);
  }

  // Bars are scaled within each unit group (the server never mixes units).
  const groupMax = new Map<string, number>();
  for (const t of totals) {
    if (t.total === null || t.unit === null) continue;
    groupMax.set(t.unit, Math.max(groupMax.get(t.unit) ?? 0, t.total));
  }

  // The chart shows the first unit group, in the server's order.
  const firstUnit = totals[0]?.total != null ? totals[0].unit : null;
  const chartRows =
    firstUnit === null
      ? []
      : totals
          .filter((t) => t.unit === firstUnit && t.total !== null)
          .map((t) => ({ name: plantName(t.commonName), total: t.total as number }));

  const gardenName = gardenId ? gardens.find((g) => g.id === gardenId)?.name : null;

  const gardenSelect = gardens.length > 1 && (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--sp-2)', fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--c-text-3)' }}>
      <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }}>
        {/* ED: replace with final copy */}
        Totals for
      </span>
      <select
        value={gardenId ?? ''}
        onChange={(e) => onGardenChange(e.target.value === '' ? null : e.target.value)}
        style={{
          minHeight: 44,
          padding: '0 var(--sp-3)',
          fontFamily: 'var(--font-ui)',
          fontSize: 14,
          color: 'var(--c-text)',
          background: 'var(--c-surface)',
          border: '1px solid var(--c-border)',
          borderRadius: 'var(--r-md)',
          cursor: 'pointer',
        }}
      >
        <option value="">All gardens</option>
        {gardens.map((g) => (
          <option key={g.id} value={g.id}>{g.name}</option>
        ))}
      </select>
    </label>
  );

  return (
    <section aria-labelledby="metrics-totals-title" aria-busy={refreshing} style={cardStyle}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--sp-2)' }}>
        {/* ED: replace with final copy */}
        <h2 id="metrics-totals-title" style={cardTitleStyle}>Harvest totals</h2>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--sp-2)' }}>
          {gardenSelect}
          {totals.length > 0 && (
            <div
              role="group"
              // ED: replace with final copy
              aria-label="Show totals as"
              style={segmentGroupStyle}
            >
              <button type="button" aria-pressed={view === 'list'} onClick={() => changeView('list')} style={segmentStyle(view === 'list')}>
                List
              </button>
              <button type="button" aria-pressed={view === 'chart'} onClick={() => changeView('chart')} style={segmentStyle(view === 'chart')}>
                Chart
              </button>
            </div>
          )}
        </div>
      </div>

      {/* While a garden toggle loads, the old totals stay, dimmed. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)', minWidth: 0, opacity: refreshing ? 0.6 : 1, transition: 'opacity 150ms' }}>
        {totals.length === 0 ? (
          <>
            <p style={bodyTextStyle}>
              {gardenName
                ? isPastSeason
                  ? `${gardenName} had no harvests logged in ${season}.`
                  : `No harvests logged in ${gardenName} this season.`
                : isPastSeason
                  ? `No harvests were logged in ${season}.`
                  : 'No harvests logged yet this season. When you log your first harvest, your totals will appear here.'}
            </p>
            {!isPastSeason && (
              <Link to="/harvest?log=new" style={{ ...linkStyle, alignSelf: 'flex-start' }}>Log a harvest</Link>
            )}
          </>
        ) : view === 'list' ? (
          <ul style={listStyle}>
            {totals.map((t) => {
              const href = harvestLinkFor(t, season);
              const max = t.unit !== null ? groupMax.get(t.unit) : undefined;
              const pct = t.total !== null && max ? Math.max(2, (t.total / max) * 100) : 0;
              const amount = formatQuantity(t.total, t.unit) ?? plural(t.entryCount, 'harvest', 'harvests');
              const content = (
                <>
                  {pct > 0 && (
                    <span
                      aria-hidden="true"
                      style={{
                        position: 'absolute',
                        left: 0,
                        top: 'var(--sp-1)',
                        bottom: 'var(--sp-1)',
                        width: `${pct}%`,
                        background: 'var(--c-primary-subtle)',
                        borderRadius: 'var(--r-md)',
                      }}
                    />
                  )}
                  <span style={{ position: 'relative', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                    <span style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{plantName(t.commonName)}</span>
                    {t.mixedUnits && <span style={secondaryTextStyle}>mixed units — see log for details</span>}
                  </span>
                  <span style={{ position: 'relative', flexShrink: 0, color: 'var(--c-text-2)', fontVariantNumeric: 'tabular-nums' }}>
                    {amount}
                  </span>
                </>
              );
              return (
                <li key={plantKeyOf(t) ?? `${t.commonName}-${t.unit}`}>
                  {href ? (
                    <Link to={href} style={rowLinkStyle}>{content}</Link>
                  ) : (
                    <div style={rowLinkStyle}>{content}</div>
                  )}
                </li>
              );
            })}
          </ul>
        ) : chartRows.length === 0 ? (
          <p style={bodyTextStyle}>Nothing to chart yet. Fill in Quantity when you log a harvest and it&rsquo;ll show up here.</p>
        ) : (
          <figure style={{ margin: 0 }}>
            <ResponsiveContainer width="100%" height={chartRows.length * 40 + 24}>
              <BarChart data={chartRows} layout="vertical" margin={{ top: 4, right: 48, bottom: 4, left: 0 }}>
                <CartesianGrid stroke="var(--c-border-subtle)" horizontal={false} />
                <XAxis type="number" hide />
                <YAxis
                  type="category"
                  dataKey="name"
                  width={110}
                  tick={{ fontFamily: 'var(--font-ui)', fontSize: 12, fill: 'var(--c-text-2)' }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  cursor={{ fill: 'var(--c-primary-subtle)' }}
                  // ED: replace with final copy
                  formatter={(value) => [formatQuantity(Number(value), firstUnit) ?? String(value), 'Total']}
                  contentStyle={{
                    fontFamily: 'var(--font-ui)',
                    fontSize: 12,
                    background: 'var(--c-surface)',
                    border: '1px solid var(--c-border)',
                    borderRadius: 'var(--r-md)',
                  }}
                />
                <Bar dataKey="total" fill="var(--c-primary)" radius={[0, 3, 3, 0]} barSize={20}>
                  <LabelList
                    dataKey="total"
                    position="right"
                    style={{ fontFamily: 'var(--font-ui)', fontSize: 12, fill: 'var(--c-text-2)' }}
                  />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            <figcaption style={{ ...secondaryTextStyle, marginTop: 'var(--sp-2)' }}>
              Plants measured in {unitWord(firstUnit as HarvestUnit)}
            </figcaption>
          </figure>
        )}
      </div>
    </section>
  );
}
