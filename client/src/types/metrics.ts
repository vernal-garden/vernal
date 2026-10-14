// Response shapes for /api/metrics (src/routes/metrics.ts). Ids are strings,
// dates YYYY-MM-DD. Every aggregate is computed on the server.

import type { HarvestUnit } from './harvest';

export type TimingStatus = 'early' | 'on_time' | 'late';
export type SowDateSource = 'planting' | 'marked_done';

export interface PlantRef {
  seedId: string | null;
  cambiumSeedId: string | null;
}

export interface MetricsGarden {
  id: string;
  name: string;
}

export interface PlantTotal extends PlantRef {
  commonName: string | null;
  total: number | null;
  unit: HarvestUnit | null;
  mixedUnits: boolean;
  entryCount: number;
}

export interface RecentEntry {
  id: string;
  commonName: string | null;
  harvestDate: string;
  quantity: number | null;
  unit: HarvestUnit | null;
  gardenName: string;
  bedLabel: string | null;
}

export interface TimingRow extends PlantRef {
  gardenId: string;
  commonName: string | null;
  sowDate: string;
  sowDateSource: SowDateSource;
  window: { name: 'indoorStart' | 'directSow'; start: string; end: string };
  status: TimingStatus;
  weeks: number;
}

export interface TrendPlant extends PlantRef {
  commonName: string | null;
  changePct: number;
  direction: 'up' | 'same' | 'down';
}

export interface Trend {
  state: 'hidden' | 'one_season' | 'ready';
  comparedSeason: number | null;
  plants: TrendPlant[];
}

export type SoilStatus = 'balanced' | 'needs_attention' | 'no_ph';

export interface SoilRow {
  gardenId: string;
  gardenName: string;
  bedId: string;
  bedLabel: string;
  ph: number | null;
  testDate: string;
  status: SoilStatus;
}

export interface AdvancedMetrics {
  yieldPerSqFt: (PlantRef & { commonName: string | null; perSqFt: number; unit: HarvestUnit | null })[];
  yieldPerSqFtReason: null | 'no_bed_data';
  topPerformer: { commonName: string | null; total: number; unit: HarvestUnit | null; entryCount: number } | null;
  frequency: { commonName: string | null; avgDaysBetween: number; entryCount: number }[];
  daysToHarvest: {
    commonName: string | null;
    actualDays: number;
    predictedMin: number;
    predictedMax: number;
    status: TimingStatus;
  }[];
}

export interface PaidMetrics {
  soil: SoilRow[];
  amendments: { applicationCount: number; bedCount: number };
  weather: { connected: boolean; provider: string | null; lastSuccessfulSync: string | null };
  advanced: AdvancedMetrics;
}

export interface DashboardResponse {
  season: number;
  currentSeason: number;
  readOnly: boolean;
  isSupporter: boolean;
  gardens: MetricsGarden[];
  empty: boolean;
  summary: { harvestCount: number; firstHarvestDate: string | null; lastHarvestDate: string | null };
  totals: PlantTotal[];
  recent: RecentEntry[];
  timing: TimingRow[];
  trend: Trend;
  paid: PaidMetrics | null;
}

export interface ComparablePlant extends PlantRef {
  commonName: string | null;
  scientificName: string | null;
  seasons: number[]; // newest first
}

export interface CrossSeasonEntry {
  id: string;
  harvestDate: string;
  quantity: number | null;
  unit: HarvestUnit | null;
  bedLabel: string | null;
  notesExcerpt: string | null;
}

export interface CrossSeasonSeason {
  season: number;
  total: number | null;
  mixedUnits: boolean;
  entryCount: number;
  firstDate: string | null;
  lastDate: string | null;
  avgDaysBetween: number | null;
  sowing: { sowDate: string; sowDateSource: SowDateSource; daysToFirstHarvest: number | null } | null;
  predicted: { min: number; max: number } | null;
  entries: CrossSeasonEntry[];
}

export interface CrossSeasonResponse {
  plant: PlantRef & { commonName: string | null; scientificName: string | null };
  availableSeasons: number[]; // newest first
  unit: HarvestUnit | null;
  gardens: MetricsGarden[];
  beds: { id: string; label: string; gardenId: string }[];
  seasons: CrossSeasonSeason[]; // ascending
}
