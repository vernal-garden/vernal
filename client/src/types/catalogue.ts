// client/src/types/catalogue.ts

// ── Browse list cards ─────────────────────────────────────────────────────────

export interface CommunityCard {
  kind: 'community';
  id: string;
  commonName: string;
  scientificName: string | null;
  plantFamily: string | null;
  illustrationKey: string | null;
  aggregateRating: number | null;
  ratingCount: number;
}

export interface PersonalCard {
  kind: 'personal';
  id: string;
  commonName: string;
  scientificName: string | null;
  plantFamily: string | null;
  illustrationKey: string | null;
  userRating: number | null;
  isFavourite: boolean;
  origin: string;
  contributionStatus: string;
  cambiumSourceId: string | null;
}

export type BrowseCard = CommunityCard | PersonalCard;

// ── Community seed detail (GET /api/catalogue/seeds/:id) ─────────────────────
// Response is the bare SeedDetail object (no wrapper).

export interface CompanionEntry {
  seed: CommunityCard;
  relationship: 'beneficial' | 'antagonistic' | 'neutral';
  confidence: number;
  notes: string | null;
  source: string | null;
}

export interface CatalogueSeedDetail {
  id: string;
  commonName: string;
  scientificName: string | null;
  plantFamily: string | null;
  illustrationKey: string | null;
  aggregateRating: number | null;
  ratingCount: number;
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
  source: 'openfarm' | 'community' | 'editorial';
  companions: CompanionEntry[];
  plantingDepthInches: number | null;
  rowSpacingInches: number | null;
  germinationDaysMin: number | null;
  germinationDaysMax: number | null;
  germinationTempMinF: number | null;
  germinationTempMaxF: number | null;
}

// ── Personal seed detail (GET /api/seeds/:id) ─────────────────────────────────

export interface PlantingHistoryEntry {
  plantingId: string;
  gardenId: string;
  gardenName: string;
  bedId: string;
  bedLabel: string;
  season: number;
  harvestLogged: boolean;
}

export interface PersonalSeedDetail {
  id: string;
  commonName: string;
  scientificName: string | null;
  plantFamily: string | null;
  illustrationKey: string | null;
  cambiumSourceId: string | null;
  origin: string;
  contributionStatus: string;
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
  userNotes: string | null;
  userRating: number | null;
  isFavourite: boolean;
  plantingDepthInches: number | null;
  rowSpacingInches: number | null;
  germinationDaysMin: number | null;
  germinationDaysMax: number | null;
  germinationTempMinF: number | null;
  germinationTempMaxF: number | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  plantingHistory: PlantingHistoryEntry[];
}

// ── Families ──────────────────────────────────────────────────────────────────

export interface FamilyEntry {
  family: string;
  count: number;
}
