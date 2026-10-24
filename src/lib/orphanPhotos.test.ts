import { describe, it, expect } from 'vitest';
import { findOrphans } from './orphanPhotos';

const HOUR = 60 * 60 * 1000;
const now = new Date('2026-10-24T12:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms);

describe('findOrphans', () => {
  it('keeps referenced keys', () => {
    const listed = [{ key: 'seed-photos/1/a.jpg', lastModified: ago(48 * HOUR) }];
    expect(findOrphans(listed, new Set(['seed-photos/1/a.jpg']), now)).toEqual([]);
  });

  it('returns an unreferenced key older than 24 h', () => {
    const listed = [{ key: 'seed-photos/1/a.jpg', lastModified: ago(25 * HOUR) }];
    expect(findOrphans(listed, new Set(), now)).toEqual(['seed-photos/1/a.jpg']);
  });

  it('skips an unreferenced key only 1 h old', () => {
    const listed = [{ key: 'seed-photos/1/a.jpg', lastModified: ago(HOUR) }];
    expect(findOrphans(listed, new Set(), now)).toEqual([]);
  });

  it('skips a key with no date', () => {
    const listed = [{ key: 'seed-photos/1/a.jpg', lastModified: null }];
    expect(findOrphans(listed, new Set(), now)).toEqual([]);
  });

  it('returns keys sorted', () => {
    const listed = [
      { key: 'harvest-photos/2/b.jpg', lastModified: ago(30 * HOUR) },
      { key: 'seed-photos/1/a.jpg', lastModified: ago(30 * HOUR) },
      { key: 'harvest-photos/1/c.jpg', lastModified: ago(30 * HOUR) },
    ];
    expect(findOrphans(listed, new Set(), now)).toEqual([
      'harvest-photos/1/c.jpg',
      'harvest-photos/2/b.jpg',
      'seed-photos/1/a.jpg',
    ]);
  });
});
