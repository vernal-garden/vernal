import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import { buildFrostStations, displayName } from './build-frost-stations';

const dir = path.join(__dirname, '..', 'src', 'data', 'noaa');
const csv = fs.readFileSync(path.join(dir, 'conus_last32_by_station.csv'), 'utf8');

describe('buildFrostStations', () => {
  const stations = buildFrostStations(csv);

  it('reproduces the committed JSON exactly', () => {
    const committed = fs.readFileSync(path.join(dir, 'frostStations.json'), 'utf8');
    expect(JSON.stringify(stations, null, 2) + '\n').toBe(committed);
  });

  it('keeps every station with a MM-DD date and a unique id', () => {
    expect(stations).toHaveLength(6782);
    for (const s of stations) expect(s.p50).toMatch(/^\d{2}-\d{2}$/);
    expect(new Set(stations.map((s) => s.id)).size).toBe(stations.length);
  });

  it('rejects a December date for a station that freezes most years', () => {
    const bad = [
      'station,name,state,lat,lon,last32_p50,prob_32f_any_year_pct',
      'X1,"TEST, CA US",CA,34.0,-118.0,12/05,60.0',
    ].join('\n');
    expect(() => buildFrostStations(bad)).toThrow(/X1/);
  });
});

describe('displayName', () => {
  it.each([
    ['SPOKANE INTL AP, WA US', 'Spokane Intl Airport'],
    ['SPOKANE FELTS FLD, WA US', 'Spokane Felts Field'],
    ['SPOKANE 17 SSW, WA US', 'Spokane 17 SSW'],
    ['SPOKANE WFO, WA US', 'Spokane WFO'],
    ['BURLEY MUNI AP, ID US', 'Burley Municipal Airport'],
    ['VALLEY OF THE GODS, UT US', 'Valley of the Gods'],
    ['APACHE 4ENE MESONET, OK US', 'Apache 4ENE Mesonet'],
  ])('%s -> %s', (raw, expected) => {
    expect(displayName(raw)).toBe(expected);
  });
});
