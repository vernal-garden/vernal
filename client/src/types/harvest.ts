// client/src/types/harvest.ts
// Response shapes of /api/harvests (src/routes/harvests.ts).

export type HarvestUnit = 'g' | 'kg' | 'oz' | 'lb' | 'count';
export type WeightUnit = Exclude<HarvestUnit, 'count'>;

export interface HarvestPhoto {
  key: string;
  url: string;
}

export interface HarvestEntry {
  id: string;
  gardenId: string;
  gardenName: string;
  bedId: string | null;
  bedLabel: string | null;
  seedId: string | null;
  cambiumSeedId: string | null;
  commonName: string | null;
  scientificName: string | null;
  harvestDate: string; // YYYY-MM-DD
  season: number;
  quantity: number | null;
  unit: HarvestUnit | null;
  qualityRating: number | null;
  notes: string | null;
  photos: HarvestPhoto[];
  sowingEventId: string | null;
  createdAt: string;
}

export interface HarvestListResponse {
  data: HarvestEntry[];
  nextCursor: string | null;
  seasons: number[];
}

export type PlantOptionSource = 'planted' | 'personal' | 'cambium';

export interface PlantOption {
  seedId: string | null;
  cambiumSeedId: string | null;
  commonName: string | null;
  scientificName: string | null;
  source: PlantOptionSource;
}

// "seed:<id>" for a personal seed, otherwise "cambium:<id>" — the API's seed
// filter format and the planting guide's ?open= format.
export type SeedParam = `seed:${string}` | `cambium:${string}`;

// Fields sent to POST / PATCH /api/harvests.
export interface HarvestInput {
  gardenId?: number;
  seedId?: number | null;
  cambiumSeedId?: number | null;
  bedId?: number | null;
  harvestDate?: string;
  quantity?: number | null;
  unit?: HarvestUnit | null;
  qualityRating?: number | null;
  notes?: string | null;
}
