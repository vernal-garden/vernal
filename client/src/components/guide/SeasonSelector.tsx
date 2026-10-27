import { segmentGroupStyle, segmentStyle } from './styles';

interface Props {
  currentSeason: number;
  season: number;
  onChange: (season: number) => void;
  // Offer the season after the current one. Defaults to true.
  includeNext?: boolean;
}

export default function SeasonSelector({ currentSeason, season, onChange, includeNext = true }: Props) {
  const seasons = includeNext ? [currentSeason - 1, currentSeason, currentSeason + 1] : [currentSeason - 1, currentSeason];
  return (
    <div role="group" aria-label="Season" style={segmentGroupStyle}>
      {seasons.map((s) => (
        <button
          key={s}
          type="button"
          aria-pressed={s === season}
          onClick={() => onChange(s)}
          style={segmentStyle(s === season)}
        >
          {s}
        </button>
      ))}
    </div>
  );
}
