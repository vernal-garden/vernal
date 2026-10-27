import type { DashboardResponse } from '../../types/metrics';
import { plural, shortDate } from './styles';

// Low-weight text under the season selector. Not a card, not interactive.
export default function SummaryStrip({
  summary,
  isPastSeason,
  season,
}: {
  summary: DashboardResponse['summary'];
  isPastSeason: boolean;
  season: number;
}) {
  const { harvestCount, firstHarvestDate, lastHarvestDate } = summary;
  let text: string;
  if (harvestCount === 0) {
    text = isPastSeason ? `No harvests were logged in ${season}.` : 'No harvests logged this season yet.';
  } else {
    const parts = [plural(harvestCount, 'harvest', 'harvests')];
    if (firstHarvestDate) parts.push(`first ${shortDate(firstHarvestDate)}`);
    if (lastHarvestDate) parts.push(`latest ${shortDate(lastHarvestDate)}`);
    text = parts.join(' · ');
  }
  return (
    <p style={{ margin: 0, fontFamily: 'var(--font-ui)', fontSize: 15, color: 'var(--c-text-2)' }}>
      {text}
    </p>
  );
}
