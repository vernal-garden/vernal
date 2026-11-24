import { describe, it, expect } from 'vitest';
import { groupPlannedByPlant, saveButtonState } from '../../client/src/lib/markStarted';

describe('saveButtonState', () => {
  it('n sums quantity of checked groups', () => {
    expect(
      saveButtonState([
        { quantity: 3, checked: true },
        { quantity: 2, checked: true },
        { quantity: 4, checked: false },
      ]),
    ).toEqual({ label: 'Mark 5 in the ground', disabled: false });
  });

  it('zero checked', () => {
    expect(saveButtonState([{ quantity: 4, checked: false }])).toEqual({
      label: 'Choose plants to mark',
      disabled: true,
    });
  });
});

describe('groupPlannedByPlant', () => {
  const r = (id: string, extra = {}) => ({
    id,
    seedId: '10',
    cambiumSeedId: null,
    companionSeedId: null,
    commonName: 'Tomato',
    quantity: 2,
    startMethod: 'sown' as const,
    state: 'planned' as const,
    ...extra,
  });

  it('merges planned rows of one seed and excludes growing', () => {
    const out = groupPlannedByPlant([r('a'), r('b', { quantity: 3 }), r('c', { state: 'growing' })]);
    expect(out).toEqual([
      { key: '10', name: 'Tomato', plantingIds: ['a', 'b'], quantity: 5, startMethod: 'sown' },
    ]);
  });

  it('sorts by name and falls back to Plant', () => {
    const out = groupPlannedByPlant([
      r('a', { seedId: '1', commonName: null }),
      r('b', { seedId: '2', commonName: 'Basil' }),
    ]);
    expect(out.map((g) => g.name)).toEqual(['Basil', 'Plant']);
  });
});
