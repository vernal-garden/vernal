// client/src/types/plantingGuide.ts
// Response shape of GET /api/planting-guide (src/routes/plantingGuide.ts).

export type WindowSource = 'custom' | 'account_frost' | 'zone_estimate';

export interface GuideWindow {
  start: string; // YYYY-MM-DD
  end: string;   // YYYY-MM-DD, inclusive
  source: WindowSource;
}

export type WindowKind = 'indoorStart' | 'transplant' | 'directSow' | 'harvest';

export type MissingReason = null | 'no_timing_data' | 'no_frost_date' | 'frost_free';

export interface GuideOverrides {
  indoorStart: string | null;
  transplant: string | null;
  directSow: string | null;
}

export type OverrideField = keyof GuideOverrides;

export interface GuideGarden {
  id: string;
  name: string;
  zone: string;
  zoneLocationLabel: string | null;
  frost: {
    lastSpringFrost: string | null;
    firstFallFrost: string | null;
    frostSource: 'account_frost' | 'zone_estimate' | null;
    frostFree: boolean;
  };
}

export interface GuideRow {
  gardenId: string;
  seedId: string | null;
  cambiumSeedId: string | null;
  commonName: string | null;
  scientificName: string | null;
  plantFamily: string | null;
  plantingCount: number;
  successionIntervalWeeks: number | null;
  frostTolerance: 'none' | 'light' | 'hard';
  weeksToTransplant: number | null;
  maturityDaysMin: number | null;
  maturityDaysMax: number | null;
  overrides: GuideOverrides | null;
  done: { sowingEventId: string | null; markedDoneAt: string | null } | null;
  windows: Record<WindowKind, GuideWindow | null>;
  missingReason: MissingReason;
}

export interface PlantingGuideResponse {
  season: number;
  currentSeason: number;
  readOnly: boolean;
  gardens: GuideGarden[];
  rows: GuideRow[];
}
