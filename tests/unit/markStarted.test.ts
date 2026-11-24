import { describe, it, expect } from 'vitest';
import { groupPlannedByPlant, planMarkSave, saveButtonState } from '../../client/src/lib/markStarted';

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

describe('planMarkSave', () => {
  type M = 'sown' | 'transplanted';
  const p = (id: string, startMethod: M, state: 'planned' | 'growing' = 'planned') => ({ id, startMethod, state });

  it('nothing ticked: no calls, control hidden', () => {
    expect(planMarkSave([p('a', 'sown'), p('b', 'transplanted')], [], null)).toEqual({
      controlMethod: null,
      mixed: false,
      calls: [],
    });
  });

  it('all sown: one sown call, control shows sown', () => {
    expect(planMarkSave([p('a', 'sown'), p('b', 'sown')], ['a', 'b'], null)).toEqual({
      controlMethod: 'sown',
      mixed: false,
      calls: [{ startMethod: 'sown', ids: ['a', 'b'] }],
    });
  });

  it('all ticked transplanted with a sown plant unticked: control shows transplanted', () => {
    // 'basil' (sown) sorts first by name but is unticked.
    const plantings = [p('basil', 'sown'), p('tomato', 'transplanted')];
    expect(planMarkSave(plantings, ['tomato'], null)).toEqual({
      controlMethod: 'transplanted',
      mixed: false,
      calls: [{ startMethod: 'transplanted', ids: ['tomato'] }],
    });
  });

  it('all sown with override transplanted: one transplanted call', () => {
    expect(planMarkSave([p('a', 'sown'), p('b', 'sown')], ['a', 'b'], 'transplanted')).toEqual({
      controlMethod: 'transplanted',
      mixed: false,
      calls: [{ startMethod: 'transplanted', ids: ['a', 'b'] }],
    });
  });

  it('mixed: sown call then transplanted call, control hidden, override ignored', () => {
    const plantings = [p('t1', 'transplanted'), p('s1', 'sown'), p('t2', 'transplanted'), p('s2', 'sown')];
    const expected = {
      controlMethod: null,
      mixed: true,
      calls: [
        { startMethod: 'sown', ids: ['s1', 's2'] },
        { startMethod: 'transplanted', ids: ['t1', 't2'] },
      ],
    };
    expect(planMarkSave(plantings, ['t1', 's1', 't2', 's2'], null)).toEqual(expected);
    expect(planMarkSave(plantings, ['t1', 's1', 't2', 's2'], 'transplanted')).toEqual(expected);
  });

  it('mixed inside one plant: two tomato plantings, one per method, make two calls', () => {
    const plantings = [p('tomato-1', 'transplanted'), p('tomato-2', 'sown')];
    expect(planMarkSave(plantings, ['tomato-1', 'tomato-2'], null)).toEqual({
      controlMethod: null,
      mixed: true,
      calls: [
        { startMethod: 'sown', ids: ['tomato-2'] },
        { startMethod: 'transplanted', ids: ['tomato-1'] },
      ],
    });
  });

  it('leaves out a growing planting even when its id is checked', () => {
    const plantings = [p('a', 'sown'), p('g', 'transplanted', 'growing')];
    expect(planMarkSave(plantings, ['a', 'g'], null)).toEqual({
      controlMethod: 'sown',
      mixed: false,
      calls: [{ startMethod: 'sown', ids: ['a'] }],
    });
  });
});
