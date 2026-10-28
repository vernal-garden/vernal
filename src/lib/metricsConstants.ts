// Tunable thresholds for the Metrics Dashboard (Phase 49).

// Days either side of a sowing window that still count as "on time".
export const TIMING_TOLERANCE_DAYS = 7;

// A year-over-year change within this many percent reads as "about the same".
export const TREND_SAME_PCT = 10;

// Soil pH range shown as "Balanced".
export const PH_BALANCED_MIN = 6.0;
export const PH_BALANCED_MAX = 7.0;

export const DASHBOARD_CACHE_TTL_MS = 5 * 60 * 1000;

// Caps on the in-memory dashboard cache: entry count and total JSON bytes.
export const DASHBOARD_CACHE_MAX_ENTRIES = 2000;
export const DASHBOARD_CACHE_MAX_BYTES = 32 * 1024 * 1024;

// Longest the dashboard waits on geocoding plus the Visual Crossing history fetch
// before reporting weather history as unavailable.
export const WEATHER_TIMEOUT_MS = 5000;
