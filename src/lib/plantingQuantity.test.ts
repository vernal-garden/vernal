import { describe, it, expect } from 'vitest';
import { mergedQuantity } from './plantingQuantity';

describe('mergedQuantity', () => {
  it('sums below the cap', () => expect(mergedQuantity(4, 12)).toBe(16));
  it('clamps a sum at 99', () => expect(mergedQuantity(90, 20)).toBe(99));
  it('stays at 99', () => expect(mergedQuantity(99, 5)).toBe(99));
  it('reaches exactly 99', () => expect(mergedQuantity(1, 98)).toBe(99));
  it('never reduces an existing quantity above 99', () => expect(mergedQuantity(150, 5)).toBe(150));
});
