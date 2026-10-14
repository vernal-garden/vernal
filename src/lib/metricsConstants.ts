// Tunable thresholds for the Metrics Dashboard (Phase 49).

// Days either side of a sowing window that still count as "on time".
export const TIMING_TOLERANCE_DAYS = 7;

// A year-over-year change within this many percent reads as "about the same".
export const TREND_SAME_PCT = 10;

// Soil pH range shown as "Balanced".
export const PH_BALANCED_MIN = 6.0;
export const PH_BALANCED_MAX = 7.0;

export const DASHBOARD_CACHE_TTL_MS = 5 * 60 * 1000;
