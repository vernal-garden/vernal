export interface FeatureGate {
  featureName: string;
  description: string;
}

export const FEATURE_GATES: Record<string, FeatureGate> = {
  soil: {
    featureName: 'Soil readings',
    description: 'Track soil pH and nutrients per bed over time.',
  },
  amendments: {
    featureName: 'Amendment log',
    description: 'Record fertilizer and amendment applications per bed.',
  },
  weather: {
    featureName: 'Weather',
    description: 'Local weather + your personal weather station, in your garden.',
  },
  // Metrics Dashboard (Phase 49) — inline UpgradeCards on /data.
  soilSummary: {
    featureName: 'Soil chemistry tracking',
    description: 'Track pH, NPK, and amendments per bed to understand how your soil changes season to season.',
  },
  amendmentSummary: {
    featureName: 'Fertilizer & amendment log',
    description: 'Log what you apply, when, and to which bed — and see how amendments correlate with your yields.',
  },
  weatherSummary: {
    featureName: 'Weather station integration',
    description: 'Connect a local weather station to see how your conditions affected your plants this season.',
  },
  advancedAnalytics: {
    featureName: 'Advanced analytics',
    description: 'See yield per square foot, how often you pick each plant, and how long each one really takes.',
  },
  // ED: replace with final copy
  crossSeason: {
    featureName: 'Cross-season comparison',
    description: 'See how a plant did across seasons, side by side.',
  },
};
