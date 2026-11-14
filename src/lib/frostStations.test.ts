import { describe, it, expect } from 'vitest';
import { nearestFrostStation, frostStationById, storedFrostStation } from './frostStations';
import { LOCATION_NOT_SET } from './constants';

describe('nearestFrostStation', () => {
  it('finds the closest station to a point', () => {
    const station = nearestFrostStation(47.62, -117.53);
    expect(station).toMatchObject({ id: 'USW00024157', name: 'Spokane Intl Airport', p50: '04-26' });
  });

  it('returns null when no station is within range', () => {
    expect(nearestFrostStation(21.31, -157.86)).toBeNull();
  });
});

describe('frostStationById', () => {
  it('returns the station with that id', () => {
    expect(frostStationById('USW00024157')).toMatchObject({ name: 'Spokane Intl Airport', p50: '04-26' });
  });

  it('returns null for an unknown id', () => {
    expect(frostStationById('NOPE')).toBeNull();
  });
});

describe('storedFrostStation', () => {
  const stored = {
    zone_location_label: 'Spokane, WA',
    frost_station_id: 'USW00024157',
    frost_station_label: 'Spokane, WA',
  };

  it('returns the stored station while the label still matches', () => {
    expect(storedFrostStation(stored)).toMatchObject({ id: 'USW00024157', p50: '04-26' });
  });

  it('ignores surrounding whitespace on the garden label', () => {
    expect(storedFrostStation({ ...stored, zone_location_label: '  Spokane, WA ' })).not.toBeNull();
  });

  it('returns null once the label has changed', () => {
    expect(storedFrostStation({ ...stored, zone_location_label: 'Cheney, WA' })).toBeNull();
  });

  it('returns null for a missing or unset label', () => {
    expect(storedFrostStation({ ...stored, zone_location_label: null })).toBeNull();
    expect(storedFrostStation({ ...stored, zone_location_label: '   ' })).toBeNull();
    expect(
      storedFrostStation({
        zone_location_label: LOCATION_NOT_SET,
        frost_station_id: 'USW00024157',
        frost_station_label: LOCATION_NOT_SET,
      }),
    ).toBeNull();
  });

  it('returns null with no stored station id or an unknown one', () => {
    expect(storedFrostStation({ ...stored, frost_station_id: null })).toBeNull();
    expect(storedFrostStation({ ...stored, frost_station_id: 'NOPE' })).toBeNull();
  });
});
