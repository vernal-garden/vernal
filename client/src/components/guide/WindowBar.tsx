import type React from 'react';
import type { WindowKind } from '../../types/plantingGuide';
import { formatRange } from '../../lib/guideDates';
import { WINDOW_NAMES } from '../../lib/guideModel';

export type BarKind = WindowKind | 'none';

const STRIPES = 'repeating-linear-gradient(45deg, var(--c-warning) 0 2px, transparent 2px 8px)';
const CROSSHATCH =
  'repeating-linear-gradient(45deg, var(--c-secondary) 0 1px, transparent 1px 7px), ' +
  'repeating-linear-gradient(-45deg, var(--c-secondary) 0 1px, transparent 1px 7px)';

export function barFill(kind: BarKind): React.CSSProperties {
  switch (kind) {
    case 'indoorStart':
      return { background: `${STRIPES}, var(--c-warning-bg)` };
    case 'transplant':
      return { background: 'var(--c-success-bg)', border: '2px dotted var(--c-success)' };
    case 'directSow':
      return { background: 'var(--c-primary-light)', border: '2px solid var(--c-primary)' };
    case 'harvest':
      return { background: `${CROSSHATCH}, var(--c-secondary-light)` };
    case 'none':
      return { background: 'transparent', border: '1px dashed var(--c-border)' };
  }
}

interface Props {
  kind: BarKind;
  start: string;
  end: string;
  // Rounded where the window starts / ends inside the visible span.
  roundStart: boolean;
  roundEnd: boolean;
  style?: React.CSSProperties;
}

export default function WindowBar({ kind, start, end, roundStart, roundEnd, style }: Props) {
  const startRadius = roundStart ? 'var(--r-full)' : 0;
  const endRadius = roundEnd ? 'var(--r-full)' : 0;
  return (
    <div
      role="img"
      aria-label={`${WINDOW_NAMES[kind]}, ${formatRange(start, end)}`}
      title={`${WINDOW_NAMES[kind]}, ${formatRange(start, end)}`}
      style={{
        boxSizing: 'border-box',
        borderTopLeftRadius: startRadius,
        borderBottomLeftRadius: startRadius,
        borderTopRightRadius: endRadius,
        borderBottomRightRadius: endRadius,
        ...barFill(kind),
        ...style,
      }}
    />
  );
}
