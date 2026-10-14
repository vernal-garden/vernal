import { describe, it, expect } from 'vitest';
import { STAGE_BOUNDS, STAGE_NAMES, stageFor } from './growthStages';

describe('stageFor', () => {
  it('returns null for a null pct', () => {
    expect(stageFor(null)).toBeNull();
  });

  it('maps exactly 0 to stage 1 (Seed)', () => {
    expect(stageFor(0)).toBe(1);
  });

  it('maps anything above 0 up to and including the seedling bound to stage 2', () => {
    expect(stageFor(0.01)).toBe(2);
    expect(stageFor(STAGE_BOUNDS.seedling)).toBe(2);
  });

  it('maps just over the seedling bound up to the vegetative bound to stage 3', () => {
    expect(stageFor(25.01)).toBe(3);
    expect(stageFor(STAGE_BOUNDS.vegetative)).toBe(3);
  });

  it('maps just over the vegetative bound up to below 100 to stage 4', () => {
    expect(stageFor(65.01)).toBe(4);
    expect(stageFor(99.99)).toBe(4);
  });

  it('maps 100 and above to stage 5 (Harvest-ready)', () => {
    expect(stageFor(STAGE_BOUNDS.ready)).toBe(5);
    expect(stageFor(120)).toBe(5);
  });
});

describe('STAGE_BOUNDS / STAGE_NAMES', () => {
  it('uses the agreed bounds', () => {
    expect(STAGE_BOUNDS).toEqual({ seedling: 25, vegetative: 65, ready: 100 });
  });

  it('names every stage', () => {
    expect(STAGE_NAMES).toEqual({
      1: 'Seed',
      2: 'Seedling',
      3: 'Vegetative',
      4: 'Flowering / fruiting',
      5: 'Harvest-ready',
    });
  });
});
