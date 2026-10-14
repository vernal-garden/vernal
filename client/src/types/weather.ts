// Mirrors src/lib/weather/insights.ts on the server.
export type WeatherInsight =
  | { kind: 'dry_spell'; precipMm: number; days: number }
  | { kind: 'temp_swing'; minLowC: number; maxHighC: number }
  | { kind: 'warming'; maxHighC: number }
  | { kind: 'cooling'; maxHighC: number }
  | { kind: 'steady'; minLowC: number; maxHighC: number }
  | { kind: 'frost_risk'; lowC: number; date: string };
