import { segmentGroupStyle, segmentStyle } from './styles';

interface Props {
  currentSeason: number;
  season: number;
  onChange: (season: number) => void;
}

export default function SeasonSelector({ currentSeason, season, onChange }: Props) {
  const seasons = [currentSeason - 1, currentSeason, currentSeason + 1];
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
