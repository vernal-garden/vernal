export interface NormalizedReading {
  readingTimestamp: string; // ISO; provider obs time, or now() for public
  temperature: number | null; // °C
  humidity: number | null; // %
  windSpeed: number | null; // m/s
  windDirection: string | null; // compass string, e.g. "NNE"
  precipitationToday: number | null; // mm
  uvIndex: number | null;
  pressure: number | null; // hPa
}

export interface DailyHistoryPoint {
  date: string; // YYYY-MM-DD
  tempMaxC: number | null;
  tempMinC: number | null;
  precipMm: number | null;
}
