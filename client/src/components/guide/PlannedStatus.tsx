import type { CSSProperties } from 'react';
import type { GuideRow, WindowKind } from '../../types/plantingGuide';
import type { Planting } from '../../hooks/usePlantings';
import { plannedNudge, rowHasPlanned } from '../../lib/guideModel';
import { formatShortDate, NUDGE_CLOSING, NUDGE_OPEN, PLANNED_TAG, untilDate } from '../../lib/planningStrings';
import { tagStyle } from './styles';

interface Props {
  row: GuideRow;
  plantings: Planting[];
  season: number;
  today: string;
  readOnly: boolean;
  // Show the tag (default true). The list view puts the tag on the sowing
  // item and the nudge on the item for the window that's open.
  showTag?: boolean;
  // Only show the nudge when it's for this window (list view items).
  nudgeKind?: WindowKind;
  align?: 'start' | 'end';
}

const nudgeLineStyle: CSSProperties = {
  fontFamily: 'var(--font-ui)',
  fontSize: 12,
  lineHeight: 1.3,
};

// The "Planned" tag and, under it, the sowing nudge for a row that still has
// planned plantings. Nothing when the Guide is read-only.
export default function PlannedStatus({ row, plantings, season, today, readOnly, showTag = true, nudgeKind, align = 'start' }: Props) {
  if (readOnly || !rowHasPlanned(row, plantings)) return null;
  const nudge = plannedNudge(row, plantings, today, readOnly);
  const showNudge = nudge !== null && (nudgeKind === undefined || nudge.kind === nudgeKind);
  if (!showTag && !showNudge) return null;
  return (
    <span
      data-testid="guide-planned"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: align === 'end' ? 'flex-end' : 'flex-start',
        gap: 2,
        flexShrink: 0,
        textAlign: align === 'end' ? 'right' : 'left',
      }}
    >
      {showTag && <span style={tagStyle}>{PLANNED_TAG}</span>}
      {showNudge && nudge && (
        <>
          <span style={{ ...nudgeLineStyle, fontWeight: 600, color: 'var(--c-text)' }}>
            {nudge.closing ? NUDGE_CLOSING[nudge.kind] : NUDGE_OPEN[nudge.kind]}
          </span>
          <span style={{ ...nudgeLineStyle, color: 'var(--c-text-2)' }}>
            {untilDate(formatShortDate(nudge.endsOn, season))}
          </span>
        </>
      )}
    </span>
  );
}
