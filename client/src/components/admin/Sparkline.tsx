import { Line, LineChart, ResponsiveContainer, Tooltip, type TooltipContentProps } from 'recharts';
import type { NameType, ValueType } from 'recharts/types/component/DefaultTooltipContent';

export interface SparklinePoint {
  label: string;
  value: number | null;
}

export interface SparklineProps {
  data: SparklinePoint[];
  formatValue: (v: number) => string;
  ariaLabel: string;
  /** Height in px (default 40). */
  height?: number;
}

export default function Sparkline({ data, formatValue, ariaLabel, height = 40 }: SparklineProps) {
  function renderTooltip({ active, payload }: TooltipContentProps<ValueType, NameType>) {
    if (!active || !payload || payload.length === 0) return null;
    const point = payload[0].payload as SparklinePoint;
    return (
      <div
        style={{
          padding: 'var(--sp-1) var(--sp-2)',
          background: 'var(--c-surface)',
          border: '1px solid var(--c-border)',
          borderRadius: 'var(--r-sm)',
          boxShadow: 'var(--shadow-sm)',
          fontFamily: 'var(--font-ui)',
          fontSize: 12,
          lineHeight: '16px',
          whiteSpace: 'nowrap',
        }}
      >
        <div style={{ color: 'var(--c-text-3)' }}>{point.label}</div>
        <div style={{ color: 'var(--c-text)', fontWeight: 600 }}>
          {point.value === null ? '—' : formatValue(point.value)}
        </div>
      </div>
    );
  }

  return (
    <div role="img" aria-label={ariaLabel} style={{ width: '100%', height }}>
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={data} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
          <Tooltip content={renderTooltip} cursor={{ stroke: 'var(--c-border)' }} isAnimationActive={false} />
          <Line
            type="monotone"
            dataKey="value"
            stroke="var(--c-primary)"
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
            connectNulls={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
