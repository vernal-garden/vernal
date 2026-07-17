import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import type { HistoryPoint } from '../../hooks/useWeather';
import { celsiusToDisplay, mmToDisplay, unitLabel, UnitSystem } from '../../lib/units';

interface ChartRow {
  label: string;
  precip: number | null;
  tempMax: number | null;
  tempMin: number | null;
}

function weekdayLabel(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00`);
  return d.toLocaleDateString(undefined, { weekday: 'short' });
}

interface Props {
  history: HistoryPoint[];
  units: UnitSystem;
}

export default function HistoryChart({ history, units }: Props) {
  if (history.length === 0) return null;

  const rows: ChartRow[] = [...history]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((h) => ({
      label: weekdayLabel(h.date),
      precip: h.precipMm !== null ? Number(mmToDisplay(h.precipMm, units).toFixed(2)) : null,
      tempMax: h.tempMaxC !== null ? Math.round(celsiusToDisplay(h.tempMaxC, units)) : null,
      tempMin: h.tempMinC !== null ? Math.round(celsiusToDisplay(h.tempMinC, units)) : null,
    }));

  return (
    <div>
      <h3
        style={{
          margin: '0 0 var(--sp-2)',
          fontFamily: 'var(--font-display)',
          fontSize: 16,
          color: 'var(--c-text)',
        }}
      >
        Past 7 days
      </h3>
      <ResponsiveContainer width="100%" height={200}>
        <ComposedChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
          <CartesianGrid stroke="var(--c-border-subtle)" vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ fontFamily: 'var(--font-ui)', fontSize: 11, fill: 'var(--c-text-3)' }}
            axisLine={{ stroke: 'var(--c-border)' }}
            tickLine={false}
          />
          <YAxis
            yAxisId="temp"
            tick={{ fontFamily: 'var(--font-ui)', fontSize: 11, fill: 'var(--c-text-3)' }}
            axisLine={false}
            tickLine={false}
            unit={unitLabel(units, 'temp')}
          />
          <YAxis
            yAxisId="precip"
            orientation="right"
            tick={{ fontFamily: 'var(--font-ui)', fontSize: 11, fill: 'var(--c-text-3)' }}
            axisLine={false}
            tickLine={false}
            unit={unitLabel(units, 'precip')}
          />
          <Tooltip
            contentStyle={{
              fontFamily: 'var(--font-ui)',
              fontSize: 12,
              background: 'var(--c-surface)',
              border: '1px solid var(--c-border)',
              borderRadius: 'var(--r-md)',
            }}
          />
          <Bar
            yAxisId="precip"
            dataKey="precip"
            name={`Precip (${unitLabel(units, 'precip')})`}
            fill="var(--c-info)"
            radius={[3, 3, 0, 0]}
            barSize={16}
          />
          <Line
            yAxisId="temp"
            type="monotone"
            dataKey="tempMax"
            name={`High (${unitLabel(units, 'temp')})`}
            stroke="var(--c-warning)"
            strokeWidth={2}
            dot={{ r: 3 }}
            connectNulls
          />
          <Line
            yAxisId="temp"
            type="monotone"
            dataKey="tempMin"
            name={`Low (${unitLabel(units, 'temp')})`}
            stroke="var(--c-primary)"
            strokeWidth={2}
            dot={{ r: 3 }}
            connectNulls
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
