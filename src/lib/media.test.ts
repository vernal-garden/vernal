import { describe, it, expect } from 'vitest';
import { MEDIA_PREFIX, mediaUrl, parseMediaKey, thumbnailKey, exportPhotoPath } from './media';

const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('mediaUrl', () => {
  it('prefixes the key with /api/media/', () => {
    expect(MEDIA_PREFIX).toBe('/api/media/');
    expect(mediaUrl(`seed-photos/4/${UUID}.jpg`)).toBe(`/api/media/seed-photos/4/${UUID}.jpg`);
  });
});

describe('parseMediaKey', () => {
  it('parses each key shape', () => {
    expect(parseMediaKey(`seed-photos/12/${UUID}.jpg`)).toEqual({ kind: 'seed', id: '12' });
    expect(parseMediaKey(`harvest-photos/7/${UUID}.jpg`)).toEqual({ kind: 'harvest', id: '7' });
    expect(parseMediaKey(`garden-thumbnails/3/${UUID}.png`)).toEqual({ kind: 'thumbnail', id: '3' });
  });

  it('rejects wrong extensions', () => {
    expect(parseMediaKey(`seed-photos/12/${UUID}.png`)).toBeNull();
    expect(parseMediaKey(`harvest-photos/7/${UUID}.png`)).toBeNull();
    expect(parseMediaKey(`garden-thumbnails/3/${UUID}.jpg`)).toBeNull();
  });

  it('rejects path traversal and extra segments', () => {
    expect(parseMediaKey(`seed-photos/12/../13/${UUID}.jpg`)).toBeNull();
    expect(parseMediaKey(`../seed-photos/12/${UUID}.jpg`)).toBeNull();
    expect(parseMediaKey(`seed-photos/12/${UUID}.jpg/extra`)).toBeNull();
    expect(parseMediaKey(`exports/1/2.zip`)).toBeNull();
  });

  it('rejects non-numeric ids, short names and empty input', () => {
    expect(parseMediaKey(`seed-photos/abc/${UUID}.jpg`)).toBeNull();
    expect(parseMediaKey('seed-photos/12/short.jpg')).toBeNull();
    expect(parseMediaKey('')).toBeNull();
  });

  it('rejects ids that do not fit an int4 column', () => {
    expect(parseMediaKey(`seed-photos/2147483648/${UUID}.jpg`)).toBeNull();
    expect(parseMediaKey(`harvest-photos/${'9'.repeat(30)}/${UUID}.jpg`)).toBeNull();
    expect(parseMediaKey(`garden-thumbnails/2147483647/${UUID}.png`)).toEqual({
      kind: 'thumbnail',
      id: '2147483647',
    });
  });
});

describe('thumbnailKey', () => {
  const key = `garden-thumbnails/5/${UUID}.png`;

  it('accepts a bare key for the same garden', () => {
    expect(thumbnailKey(key, '5')).toBe(key);
  });

  it('accepts a URL on any host that ends in /key', () => {
    expect(thumbnailKey(`https://pub-abc.r2.dev/${key}`, '5')).toBe(key);
    expect(thumbnailKey(`https://cdn.example.com/some/path/${key}`, '5')).toBe(key);
  });

  it("rejects another garden's key", () => {
    expect(thumbnailKey(key, '6')).toBeNull();
    expect(thumbnailKey(`https://pub-abc.r2.dev/${key}`, '55')).toBeNull();
  });

  it('rejects null, junk and non-thumbnail keys', () => {
    expect(thumbnailKey(null, '5')).toBeNull();
    expect(thumbnailKey('not a url', '5')).toBeNull();
    expect(thumbnailKey(`seed-photos/5/${UUID}.jpg`, '5')).toBeNull();
    expect(thumbnailKey(`https://x.test/garden-thumbnails/5/${UUID}.png?x=1`, '5')).toBeNull();
  });
});

describe('exportPhotoPath', () => {
  it('maps photo keys into the photos folder', () => {
    expect(exportPhotoPath(`seed-photos/12/${UUID}.jpg`)).toBe(`photos/seeds/12/${UUID}.jpg`);
    expect(exportPhotoPath(`harvest-photos/7/${UUID}.jpg`)).toBe(`photos/harvests/7/${UUID}.jpg`);
  });

  it('returns null for thumbnails and anything malformed', () => {
    expect(exportPhotoPath(`garden-thumbnails/3/${UUID}.png`)).toBeNull();
    expect(exportPhotoPath('../../etc/passwd')).toBeNull();
  });
});
