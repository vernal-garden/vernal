import { describe, it, expect } from 'vitest';
import { nearestFrostStation, frostStationById } from './frostStations';

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
