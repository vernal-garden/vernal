import stationData from '../data/noaa/frostStations.json';

export interface FrostStation {
  id: string;
  name: string;
  lat: number;
  lon: number;
  // Median last spring freeze, 'MM-DD'.
  p50: string;
  freezePct: number;
}

// Farther than this, a station says little about the garden's frost dates.
export const FROST_STATION_MAX_KM = 100;

const EARTH_RADIUS_KM = 6371;

const stations: FrostStation[] = stationData;
const stationsById = new Map<string, FrostStation>(stations.map((s) => [s.id, s]));

const toRad = (deg: number): number => (deg * Math.PI) / 180;

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

// The closest station, or null when even that one is over FROST_STATION_MAX_KM away.
export function nearestFrostStation(lat: number, lon: number): FrostStation | null {
  let best: FrostStation | null = null;
  let bestKm = Infinity;
  for (const station of stations) {
    const km = haversineKm(lat, lon, station.lat, station.lon);
    if (km < bestKm) {
      best = station;
      bestKm = km;
    }
  }
  return best && bestKm <= FROST_STATION_MAX_KM ? best : null;
}

export function frostStationById(id: string): FrostStation | null {
  return stationsById.get(id) ?? null;
}
