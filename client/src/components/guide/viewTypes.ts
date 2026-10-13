import type { GuideGarden, GuideRow } from '../../types/plantingGuide';

export interface GuideViewProps {
  rows: GuideRow[];            // already filtered, in display order
  gardens: GuideGarden[];
  season: number;
  isCurrentSeason: boolean;
  today: string;               // Pacific calendar date, YYYY-MM-DD
  showGardenName: boolean;     // the user has more than one garden
  isMobile: boolean;
  onOpen: (row: GuideRow) => void;
}

export function gardenOf(gardens: GuideGarden[], row: GuideRow): GuideGarden | undefined {
  return gardens.find((g) => g.id === row.gardenId);
}
