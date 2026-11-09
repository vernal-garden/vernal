import { describe, it, expect } from 'vitest';
import { deriveConflicts, conflictLines } from '../../client/src/lib/conflicts';
import type { Bed } from '../../client/src/hooks/useGarden';
import type { Planting } from '../../client/src/hooks/usePlantings';

// Symmetric by construction: a pair is stored once under its sorted key.
function relationships(antagonistic: [string, string][], beneficial: [string, string][] = []) {
  const key = (a: string, b: string) => [a, b].sort().join('|');
  const bad = new Set(antagonistic.map(([a, b]) => key(a, b)));
  const good = new Set(beneficial.map(([a, b]) => key(a, b)));
  return (a: string, b: string): 'beneficial' | 'antagonistic' | null => {
    const k = key(a, b);
    if (bad.has(k)) return 'antagonistic';
    if (good.has(k)) return 'beneficial';
    return null;
  };
}

function bed(id: string, type: 'grid' | 'freeform'): Bed {
  return { id, type } as Bed;
}

function planting(
  id: string,
  seed: string,
  at: { cell?: { x: number; y: number }; point?: { x: number; y: number } },
  extra: Partial<Planting> = {},
): Planting {
  return {
    id,
    companionSeedId: seed,
    spacingInches: 12,
    cell: at.cell ?? null,
    point: at.point ?? null,
    commonName: seed,
    ...extra,
  } as Planting;
}

function mapToObject(m: Map<string, Set<string>>) {
  return Object.fromEntries([...m].map(([k, v]) => [k, [...v].sort()]));
}

describe('deriveConflicts', () => {
  const rel = relationships([['tomato', 'fennel']]);

  it('grid: orthogonal antagonistic neighbours are both conflicted and map to each other', () => {
    const plantings = [
      planting('p1', 'tomato', { cell: { x: 0, y: 0 } }),
      planting('p2', 'fennel', { cell: { x: 1, y: 0 } }),
    ];
    const r = deriveConflicts({ beds: [bed('b1', 'grid')], plantingsByBedId: { b1: plantings }, relationshipBetween: rel });
    expect([...r.conflictedIds].sort()).toEqual(['p1', 'p2']);
    expect([...r.conflictedBedIds]).toEqual(['b1']);
    expect(mapToObject(r.conflictsByPlantingId)).toEqual({ p1: ['p2'], p2: ['p1'] });
  });

  it('grid: diagonal neighbours are not conflicted', () => {
    const plantings = [
      planting('p1', 'tomato', { cell: { x: 0, y: 0 } }),
      planting('p2', 'fennel', { cell: { x: 1, y: 1 } }),
    ];
    const r = deriveConflicts({ beds: [bed('b1', 'grid')], plantingsByBedId: { b1: plantings }, relationshipBetween: rel });
    expect(r.conflictedIds.size).toBe(0);
    expect(r.conflictsByPlantingId.size).toBe(0);
  });

  it('reversing a bed\'s plantings gives the same result', () => {
    const plantings = [
      planting('p1', 'tomato', { cell: { x: 1, y: 1 } }),
      planting('p2', 'fennel', { cell: { x: 0, y: 1 } }),
      planting('p3', 'fennel', { cell: { x: 1, y: 0 } }),
      planting('p4', 'tomato', { cell: { x: 3, y: 3 } }),
    ];
    const beds = [bed('b1', 'grid')];
    const fwd = deriveConflicts({ beds, plantingsByBedId: { b1: plantings }, relationshipBetween: rel });
    const rev = deriveConflicts({ beds, plantingsByBedId: { b1: [...plantings].reverse() }, relationshipBetween: rel });
    expect([...rev.conflictedIds].sort()).toEqual([...fwd.conflictedIds].sort());
    expect(mapToObject(rev.conflictsByPlantingId)).toEqual(mapToObject(fwd.conflictsByPlantingId));
    expect(mapToObject(fwd.conflictsByPlantingId)).toEqual({ p1: ['p2', 'p3'], p2: ['p1'], p3: ['p1'] });
  });

  it('freeform: conflicted inside the threshold, not outside it', () => {
    // 12in spacing on both → threshold max(15 + 15, GRID_PX = 30) = 30px.
    const beds = [bed('b1', 'freeform')];
    const near = deriveConflicts({
      beds,
      plantingsByBedId: { b1: [planting('p1', 'tomato', { point: { x: 0, y: 0 } }), planting('p2', 'fennel', { point: { x: 20, y: 0 } })] },
      relationshipBetween: rel,
    });
    expect([...near.conflictedIds].sort()).toEqual(['p1', 'p2']);
    expect(mapToObject(near.conflictsByPlantingId)).toEqual({ p1: ['p2'], p2: ['p1'] });

    const far = deriveConflicts({
      beds,
      plantingsByBedId: { b1: [planting('p1', 'tomato', { point: { x: 0, y: 0 } }), planting('p2', 'fennel', { point: { x: 40, y: 0 } })] },
      relationshipBetween: rel,
    });
    expect(far.conflictedIds.size).toBe(0);
    expect(far.conflictsByPlantingId.size).toBe(0);
  });

  it('a beneficial-only neighbour gives no conflict and no entry', () => {
    const plantings = [
      planting('p1', 'tomato', { cell: { x: 0, y: 0 } }),
      planting('p2', 'basil', { cell: { x: 1, y: 0 } }),
    ];
    const r = deriveConflicts({
      beds: [bed('b1', 'grid')],
      plantingsByBedId: { b1: plantings },
      relationshipBetween: relationships([], [['tomato', 'basil']]),
    });
    expect(r.conflictedIds.size).toBe(0);
    expect(r.conflictsByPlantingId.has('p1')).toBe(false);
    expect(r.conflictsByPlantingId.has('p2')).toBe(false);
  });
});

describe('conflictLines', () => {
  function linesFor(plantings: Planting[], id: string, antagonistic: [string, string][]) {
    const { conflictsByPlantingId } = deriveConflicts({
      beds: [bed('b1', 'grid')],
      plantingsByBedId: { b1: plantings },
      relationshipBetween: relationships(antagonistic),
    });
    return conflictLines(id, plantings, conflictsByPlantingId);
  }

  it('two Basil plantings beside one Tomato give one Basil line', () => {
    const plantings = [
      planting('t', 'tomato', { cell: { x: 1, y: 0 } }, { commonName: 'Tomato' }),
      planting('b1', 'basil', { cell: { x: 0, y: 0 } }, { commonName: 'Basil' }),
      planting('b2', 'basil', { cell: { x: 2, y: 0 } }, { commonName: 'Basil' }),
    ];
    expect(linesFor(plantings, 't', [['tomato', 'basil']])).toEqual({ names: ['Basil'], more: 0 });
  });

  it('four conflicting neighbour seeds give the first two names alphabetically and more 2', () => {
    const plantings = [
      planting('t', 'tomato', { cell: { x: 1, y: 1 } }, { commonName: 'Tomato' }),
      planting('n1', 'potato', { cell: { x: 1, y: 0 } }, { commonName: 'Potato' }),
      planting('n2', 'fennel', { cell: { x: 0, y: 1 } }, { commonName: 'fennel' }),
      planting('n3', 'corn', { cell: { x: 2, y: 1 } }, { commonName: 'Corn' }),
      planting('n4', 'dill', { cell: { x: 1, y: 2 } }, { commonName: 'Dill' }),
    ];
    const antagonistic: [string, string][] = [['tomato', 'potato'], ['tomato', 'fennel'], ['tomato', 'corn'], ['tomato', 'dill']];
    expect(linesFor(plantings, 't', antagonistic)).toEqual({ names: ['Corn', 'Dill'], more: 2 });
  });

  it('falls back to _commonName when commonName is null', () => {
    const plantings = [
      planting('t', 'tomato', { cell: { x: 0, y: 0 } }, { commonName: 'Tomato' }),
      planting('f', 'fennel', { cell: { x: 1, y: 0 } }, { commonName: null, _commonName: 'Fennel' }),
    ];
    expect(linesFor(plantings, 't', [['tomato', 'fennel']])).toEqual({ names: ['Fennel'], more: 0 });
  });

  it('an unconflicted planting gives no lines', () => {
    const plantings = [
      planting('t', 'tomato', { cell: { x: 0, y: 0 } }, { commonName: 'Tomato' }),
      planting('f', 'fennel', { cell: { x: 2, y: 0 } }, { commonName: 'Fennel' }),
    ];
    expect(linesFor(plantings, 't', [['tomato', 'fennel']])).toEqual({ names: [], more: 0 });
  });
});
