// Canonical usage_events keys and micro-feedback triggers for the admin
// Features page. Order here is the order the admin UI lists them in.

export const EVENT_KEYS = [
  { key: 'canvas_session', label: 'Garden canvas — session', tier: 'free' },
  { key: 'canvas_plant_placed', label: 'Canvas — plant placed', tier: 'free' },
  { key: 'canvas_companion_warning', label: 'Canvas — companion warning triggered', tier: 'free' },
  { key: 'canvas_season_overlay', label: 'Canvas — season overlay used', tier: 'free' },
  { key: 'planting_guide_entry_saved', label: 'Planting guide — entry saved', tier: 'free' },
  { key: 'harvest_entry_saved', label: 'Harvest log — entry saved', tier: 'free' },
  { key: 'seed_catalogue_seed_added', label: 'Seed catalogue — seed added', tier: 'free' },
  { key: 'community_seed_submitted', label: 'Community seed — contribution submitted', tier: 'free' },
  { key: 'metrics_dashboard_viewed', label: 'Metrics dashboard — viewed', tier: 'free' },
  { key: 'crossseason_comparison_viewed', label: 'Cross-season comparison — viewed', tier: 'paid' },
  { key: 'pdf_harvest_export', label: 'PDF harvest export', tier: 'paid' },
  { key: 'soil_entry_saved', label: 'Soil readings — entry saved', tier: 'paid' },
  { key: 'fertilizer_entry_saved', label: 'Fertilizer log — entry saved', tier: 'paid' },
  { key: 'weather_station_pull', label: 'Weather station — data pulled', tier: 'paid' },
] as const satisfies readonly { key: string; label: string; tier: 'free' | 'paid' }[];

export type EventKey = (typeof EVENT_KEYS)[number]['key'];

const EVENT_KEY_SET: ReadonlySet<string> = new Set(EVENT_KEYS.map((e) => e.key));

export function isEventKey(value: string): value is EventKey {
  return EVENT_KEY_SET.has(value);
}

// flag = the accounts.mf_* column set when the prompt is shown;
// triggerKey = micro_feedback_responses.trigger_key for the answers.
export const MICRO_FEEDBACK_TRIGGERS = [
  { flag: 'mf_viewed_seed', triggerKey: 'viewed_seed', label: 'First seed viewed' },
  { flag: 'mf_planted', triggerKey: 'planted', label: 'First plant placed' },
  { flag: 'mf_harvest_logged', triggerKey: 'harvest_logged', label: 'First harvest logged' },
  { flag: 'mf_cross_season', triggerKey: 'cross_season', label: 'Cross-season comparison' },
  { flag: 'mf_data_export', triggerKey: 'data_export', label: 'First data export' },
] as const;
