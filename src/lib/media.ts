// Photos and garden thumbnails are private: the client only ever sees
// /api/media/<key>, which checks ownership and redirects to a signed R2 link.
import { isNumericId } from './validation';

export const MEDIA_PREFIX = '/api/media/';

export type MediaKind = 'seed' | 'harvest' | 'thumbnail';

const UUID_NAME = '[0-9a-f-]{36}';
const KEY_PATTERNS: [MediaKind, RegExp][] = [
  ['seed', new RegExp(`^seed-photos/(\\d+)/${UUID_NAME}\\.jpg$`)],
  ['harvest', new RegExp(`^harvest-photos/(\\d+)/${UUID_NAME}\\.jpg$`)],
  ['thumbnail', new RegExp(`^garden-thumbnails/(\\d+)/${UUID_NAME}\\.png$`)],
];

export function mediaUrl(key: string): string {
  return MEDIA_PREFIX + key;
}

/**
 * The kind and owning id of a media key, or null for anything else. The id
 * must fit an int4 column, so a lookup can never fail on an out-of-range id.
 */
export function parseMediaKey(key: string): { kind: MediaKind; id: string } | null {
  for (const [kind, re] of KEY_PATTERNS) {
    const m = re.exec(key);
    if (m) return isNumericId(m[1]) ? { kind, id: m[1] } : null;
  }
  return null;
}

/**
 * The thumbnail key this garden owns, from a stored value that is either the
 * bare key or an old public URL ending in "/<key>". Null for anything else,
 * including a key under another garden.
 */
export function thumbnailKey(stored: string | null, gardenId: string): string | null {
  if (!stored) return null;
  const at = stored.lastIndexOf('garden-thumbnails/');
  if (at < 0) return null;
  if (at > 0 && stored[at - 1] !== '/') return null;
  const key = stored.slice(at);
  const parsed = parseMediaKey(key);
  return parsed?.kind === 'thumbnail' && parsed.id === gardenId ? key : null;
}

/** Where a photo lives inside a data export ZIP, or null if it is not exported. */
export function exportPhotoPath(key: string): string | null {
  const parsed = parseMediaKey(key);
  if (!parsed || parsed.kind === 'thumbnail') return null;
  const name = key.slice(key.lastIndexOf('/') + 1);
  return `photos/${parsed.kind === 'seed' ? 'seeds' : 'harvests'}/${parsed.id}/${name}`;
}
