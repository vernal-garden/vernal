import type React from 'react';
import { MONTH_SHORT, parseDay } from '../../lib/guideDates';
import type { PlantRef, TimingStatus } from '../../types/metrics';

// Shared styles and formatting for the Metrics Dashboard cards. Button and link
// styles come from the planting guide; every interactive element is at least
// 44x44px.
export {
  linkStyle,
  primaryButtonStyle,
  segmentGroupStyle,
  segmentStyle,
  textButtonStyle,
  tagStyle,
} from '../guide/styles';

export const cardStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--sp-3)',
  padding: 'var(--sp-5)',
  background: 'var(--c-surface)',
  border: '1px solid var(--c-border-subtle)',
  borderRadius: 'var(--r-lg)',
  boxShadow: 'var(--shadow-sm)',
  fontFamily: 'var(--font-ui)',
  minWidth: 0,
  boxSizing: 'border-box',
};

export const cardTitleStyle: React.CSSProperties = {
  margin: 0,
  fontFamily: 'var(--font-display)',
  fontSize: 18,
  fontWeight: 600,
  color: 'var(--c-text)',
};

export const bodyTextStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 14,
  lineHeight: 1.6,
  color: 'var(--c-text-2)',
};

export const secondaryTextStyle: React.CSSProperties = {
  fontSize: 13,
  color: 'var(--c-text-3)',
};

export const listStyle: React.CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
};

// A full-width row link (44px min height) inside a card list.
export const rowLinkStyle: React.CSSProperties = {
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 'var(--sp-3)',
  minHeight: 44,
  padding: 'var(--sp-2) var(--sp-3)',
  borderRadius: 'var(--r-md)',
  color: 'var(--c-text)',
  textDecoration: 'none',
  fontSize: 14,
};

export const subheadingStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--c-text-3)',
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
};

// Status dots: always paired with a text label.
export const STATUS_COLOR: Record<TimingStatus, string> = {
  early: 'var(--c-warning)',
  on_time: 'var(--c-success)',
  late: 'var(--c-danger)',
};

export function dotStyle(color: string): React.CSSProperties {
  return {
    display: 'inline-block',
    flexShrink: 0,
    width: 10,
    height: 10,
    borderRadius: 'var(--r-full)',
    background: color,
  };
}

// seed:<id> for a personal seed, otherwise cambium:<id>; null when neither.
export function plantKeyOf(p: PlantRef): string | null {
  if (p.seedId !== null) return `seed:${p.seedId}`;
  if (p.cambiumSeedId !== null) return `cambium:${p.cambiumSeedId}`;
  return null;
}

export function harvestLinkFor(p: PlantRef, season: number): string | null {
  const key = plantKeyOf(p);
  return key === null ? null : `/harvest?seed=${encodeURIComponent(key)}&season=${season}`;
}

export function plantName(name: string | null): string {
  return name ?? 'Unnamed plant';
}

// "May 10"
export function shortDate(key: string): string {
  const { m, d } = parseDay(key);
  return `${MONTH_SHORT[m - 1]} ${d}`;
}

// "May 10, 2025"
export function shortDateWithYear(key: string): string {
  const { y } = parseDay(key);
  return `${shortDate(key)}, ${y}`;
}

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}
