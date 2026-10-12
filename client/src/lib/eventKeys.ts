// Mirrors src/lib/eventKeys.ts on the server (keys only, same order).
// A server test asserts the two lists stay in sync.
export const EVENT_KEYS = [
  'canvas_session',
  'canvas_plant_placed',
  'canvas_companion_warning',
  'canvas_season_overlay',
  'planting_guide_entry_saved',
  'harvest_entry_saved',
  'seed_catalogue_seed_added',
  'community_seed_submitted',
  'metrics_dashboard_viewed',
  'crossseason_comparison_viewed',
  'pdf_harvest_export',
  'soil_entry_saved',
  'fertilizer_entry_saved',
  'weather_station_pull',
] as const;

export type EventKey = typeof EVENT_KEYS[number];
