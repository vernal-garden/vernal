export interface SeedSummary {
  id: string;                       // int serialized as string
  commonName: string;
  scientificName: string | null;
  plantFamily: string | null;
  illustrationKey: string | null;
  aggregateRating: number | null;
  ratingCount: number;
}

export interface SeedDetail extends SeedSummary {
  spacingInches: number | null;
  maturityDaysMin: number | null;
  maturityDaysMax: number | null;
  sunlight: string | null;
  wateringNeeds: string | null;
  hardinessZoneMin: string | null;
  hardinessZoneMax: string | null;
  frostTolerance: string | null;
  weeksToTransplant: number | null;
  successionIntervalWeeks: number | null;
  plantingDepthInches: number | null;
  rowSpacingInches: number | null;
  germinationDaysMin: number | null;
  germinationDaysMax: number | null;
  germinationTempMinF: number | null;
  germinationTempMaxF: number | null;
  source: 'openfarm' | 'community' | 'editorial';
  companions: CompanionEntry[];
}

export interface CompanionEntry {
  seed: SeedSummary;
  relationship: 'beneficial' | 'antagonistic' | 'neutral';
  confidence: number;
  notes: string | null;
  source: string | null;
}

export interface SeedSearchOptions {
  query?: string;
  family?: string;
  limit?: number;
  offset?: number;
}
