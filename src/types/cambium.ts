export interface PlantTag {
  slug: string;
  label: string;
  category: string | null;
}

export interface PlantSummary {
  id: string; // bigint serialized as string for JSON safety
  slug: string;
  botanicalName: string;
  commonNames: string[];
  tags: PlantTag[];
}

export interface GrowingAttributes {
  daysToGerminationMin: number | null;
  daysToGerminationMax: number | null;
  daysToMaturityMin: number | null;
  daysToMaturityMax: number | null;
  spacingCmMin: number | null;
  spacingCmMax: number | null;
  rowSpacingCm: number | null;
  plantHeightCmMin: number | null;
  plantHeightCmMax: number | null;
  sunRequirements: string | null;
  waterRequirements: string | null;
  frostHardy: boolean | null;
  directSow: boolean | null;
  transplant: boolean | null;
}

export interface SoilPreferences {
  phMin: number | null;
  phMax: number | null;
  nitrogenDemand: string | null;
  phosphorusDemand: string | null;
  potassiumDemand: string | null;
  moisturePreference: string | null;
  drainage: string | null;
}

export interface CompanionEntry {
  plant: PlantSummary;
  relationship: 'beneficial' | 'antagonistic' | 'neutral';
  confidence: number;
  notes: string | null;
  source: string | null;
}

export interface PlantDetail extends PlantSummary {
  description: string | null;
  family: string | null;
  genus: string;
  species: string;
  cultivar: string | null;
  growingAttributes: GrowingAttributes | null;
  soilPreferences: SoilPreferences | null;
  companions: CompanionEntry[];
}

export interface PlantSearchOptions {
  query: string;
  limit?: number;
  offset?: number;
  tagSlug?: string;
}
