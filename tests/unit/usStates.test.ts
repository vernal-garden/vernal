import { describe, it, expect } from 'vitest';
import { US_STATES, US_TERRITORIES, residenceName } from '../../client/src/lib/usStates';
import { US_STATE_CODES } from '../../src/lib/beta';

describe('usStates', () => {
  it('the state and territory codes equal the server list, 56 of each, no duplicates', () => {
    const codes = [...US_STATES, ...US_TERRITORIES].map((s) => s.code);
    expect(codes).toHaveLength(56);
    expect(new Set(codes).size).toBe(56);
    expect(US_STATE_CODES).toHaveLength(56);
    expect(new Set(codes)).toEqual(new Set(US_STATE_CODES));
  });

  it('US_STATES is sorted by name and includes DC', () => {
    const names = US_STATES.map((s) => s.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(US_STATES.some((s) => s.code === 'DC')).toBe(true);
  });

  it('US_TERRITORIES is in the specified order', () => {
    expect(US_TERRITORIES.map((s) => s.code)).toEqual(['PR', 'GU', 'VI', 'AS', 'MP']);
  });

  it('residenceName maps codes and returns null for anything else', () => {
    expect(residenceName('WA')).toBe('Washington');
    expect(residenceName('VI')).toBe('U.S. Virgin Islands');
    expect(residenceName('OUTSIDE_US')).toBeNull();
  });
});
