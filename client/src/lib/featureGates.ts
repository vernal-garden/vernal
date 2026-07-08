export interface FeatureGate {
  featureName: string;
  description: string;
}

export const FEATURE_GATES: Record<string, FeatureGate> = {
  soil: {
    featureName: 'Soil readings',
    description: 'Track soil pH and nutrients per bed over time.',
  },
};
