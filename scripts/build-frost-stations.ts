import fs from 'fs';
import path from 'path';

export interface FrostStation {
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** Median last 32°F freeze of spring, as MM-DD. */
  p50: string;
  /** Chance of any 32°F freeze in a year, 0 to 100. */
  freezePct: number;
}

const KEEP = new Set([
  'N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW', 'NNE', 'ENE', 'ESE', 'SSE', 'SSW', 'WSW', 'WNW', 'NNW',
  'WFO', 'WWTP', 'NWS', 'ANG',
]);
const EXPAND: Record<string, string> = {
  AP: 'Airport',
  FLD: 'Field',
  RGNL: 'Regional',
  MUNI: 'Municipal',
  STN: 'Station',
  EXP: 'Experiment',
};
const SMALL = new Set(['OF', 'THE', 'AND']);

function titleCase(token: string): string {
  return token
    .toLowerCase()
    .replace(/(^|[-/])([a-z])/g, (_m, sep: string, c: string) => sep + c.toUpperCase());
}

/** 'SPOKANE INTL AP, WA US' -> 'Spokane Intl Airport' */
export function displayName(raw: string): string {
  const base = raw.replace(/,\s*[A-Z]{2} US\s*$/, '');
  return base
    .split(' ')
    .filter((t) => t !== '')
    .map((token, i) => {
      if (EXPAND[token]) return EXPAND[token];
      if (KEEP.has(token) || /[0-9#]/.test(token)) return token;
      if (SMALL.has(token) && i > 0) return token.toLowerCase();
      return titleCase(token);
    })
    .join(' ');
}

/** Splits CSV text into rows of fields; handles quoted fields, "" escapes and CRLF. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

export function buildFrostStations(csv: string): FrostStation[] {
  const [header, ...rows] = parseCsv(csv);
  const col = (name: string): number => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`CSV has no ${name} column`);
    return i;
  };
  const iStation = col('station');
  const iName = col('name');
  const iLat = col('lat');
  const iLon = col('lon');
  const iP50 = col('last32_p50');
  const iPct = col('prob_32f_any_year_pct');

  return rows.map((r) => {
    const id = r[iStation];
    const m = /^(\d{2})\/(\d{2})$/.exec(r[iP50]);
    if (!m) throw new Error(`Station ${id}: last32_p50 "${r[iP50]}" is not MM/DD`);
    const lat = Number(r[iLat]);
    const lon = Number(r[iLon]);
    if (r[iLat] === '' || r[iLon] === '' || Number.isNaN(lat) || Number.isNaN(lon)) {
      throw new Error(`Station ${id}: lat/lon "${r[iLat]}", "${r[iLon]}" is not a number`);
    }
    const freezePct = Number(r[iPct]);
    if (r[iPct] === '' || Number.isNaN(freezePct)) {
      throw new Error(`Station ${id}: prob_32f_any_year_pct "${r[iPct]}" is not a number`);
    }
    // A December last-freeze date would land in the wrong year; only frost-free stations may have one.
    if (m[1] === '12' && freezePct >= 50) {
      throw new Error(`Station ${id}: December p50 ${r[iP50]} with freeze chance ${freezePct}%`);
    }
    return { id, name: displayName(r[iName]), lat, lon, p50: `${m[1]}-${m[2]}`, freezePct };
  });
}

if (require.main === module) {
  const dir = path.join(__dirname, '..', 'src', 'data', 'noaa');
  const csv = fs.readFileSync(path.join(dir, 'conus_last32_by_station.csv'), 'utf8');
  const stations = buildFrostStations(csv);
  fs.writeFileSync(path.join(dir, 'frostStations.json'), JSON.stringify(stations, null, 2) + '\n');
  console.log(`Wrote ${stations.length} stations`);
}
