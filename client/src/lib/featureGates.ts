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
};
