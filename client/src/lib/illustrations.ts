// Growth-stage art for canvas markers and catalogue cards. Each entry maps an
// illustration_key (cambium.seeds) to its five stage files in
// client/public/illustrations/. A key with no entry has no art yet and callers
// fall back to the plain marker.

export type CropClass = 'F' | 'L' | 'B';

type Stage = 1 | 2 | 3 | 4 | 5;

export const ILLUSTRATIONS: Record<string, Record<Stage, string>> = {
  'bush-bean': {
    1: 'bush-bean-1-seed.svg',
    2: 'bush-bean-2-seedling.svg',
    3: 'bush-bean-3-vegetative.svg',
    4: 'bush-bean-4-flowering.svg',
    5: 'bush-bean-5-harvest.svg',
  },
  'carrot': {
    1: 'carrot-1-seed.svg',
    2: 'carrot-2-seedling.svg',
    3: 'carrot-3-vegetative.svg',
    4: 'carrot-4-sizing.svg',
    5: 'carrot-5-harvest.svg',
  },
  'cilantro': {
    1: 'cilantro-1-seed.svg',
    2: 'cilantro-2-seedling.svg',
    3: 'cilantro-3-vegetative.svg',
    4: 'cilantro-4-sizing.svg',
    5: 'cilantro-5-harvest.svg',
  },
  'cucumber': {
    1: 'cucumber-1-seed.svg',
    2: 'cucumber-2-seedling.svg',
    3: 'cucumber-3-vegetative.svg',
    4: 'cucumber-4-flowering.svg',
    5: 'cucumber-5-harvest.svg',
  },
  'leaf-lettuce': {
    1: 'leaf-lettuce-1-seed.svg',
    2: 'leaf-lettuce-2-seedling.svg',
    3: 'leaf-lettuce-3-vegetative.svg',
    4: 'leaf-lettuce-4-sizing.svg',
    5: 'leaf-lettuce-5-harvest.svg',
  },
  'onion': {
    1: 'onion-1-seed.svg',
    2: 'onion-2-seedling.svg',
    3: 'onion-3-vegetative.svg',
    4: 'onion-4-sizing.svg',
    5: 'onion-5-harvest.svg',
  },
  'parsley': {
    1: 'parsley-1-seed.svg',
    2: 'parsley-2-seedling.svg',
    3: 'parsley-3-vegetative.svg',
    4: 'parsley-4-sizing.svg',
    5: 'parsley-5-harvest.svg',
  },
  'pea': {
    1: 'pea-1-seed.svg',
    2: 'pea-2-seedling.svg',
    3: 'pea-3-vegetative.svg',
    4: 'pea-4-flowering.svg',
    5: 'pea-5-harvest.svg',
  },
  'pepper': {
    1: 'pepper-1-seed.svg',
    2: 'pepper-2-seedling.svg',
    3: 'pepper-3-vegetative.svg',
    4: 'pepper-4-flowering.svg',
    5: 'pepper-5-harvest.svg',
  },
  'pole-bean': {
    1: 'pole-bean-1-seed.svg',
    2: 'pole-bean-2-seedling.svg',
    3: 'pole-bean-3-vegetative.svg',
    4: 'pole-bean-4-flowering.svg',
    5: 'pole-bean-5-harvest.svg',
  },
  'potato': {
    1: 'potato-1-seed.svg',
    2: 'potato-2-seedling.svg',
    3: 'potato-3-vegetative.svg',
    4: 'potato-4-flowering.svg',
    5: 'potato-5-harvest.svg',
  },
  'pumpkin': {
    1: 'pumpkin-1-seed.svg',
    2: 'pumpkin-2-seedling.svg',
    3: 'pumpkin-3-vegetative.svg',
    4: 'pumpkin-4-flowering.svg',
    5: 'pumpkin-5-harvest.svg',
  },
  'radish': {
    1: 'radish-1-seed.svg',
    2: 'radish-2-seedling.svg',
    3: 'radish-3-vegetative.svg',
    4: 'radish-4-sizing.svg',
    5: 'radish-5-harvest.svg',
  },
  'rosemary': {
    1: 'rosemary-1-seed.svg',
    2: 'rosemary-2-seedling.svg',
    3: 'rosemary-3-vegetative.svg',
    4: 'rosemary-4-sizing.svg',
    5: 'rosemary-5-harvest.svg',
  },
  'spearmint': {
    1: 'spearmint-1-seed.svg',
    2: 'spearmint-2-seedling.svg',
    3: 'spearmint-3-vegetative.svg',
    4: 'spearmint-4-sizing.svg',
    5: 'spearmint-5-harvest.svg',
  },
  'summer-squash': {
    1: 'summer-squash-1-seed.svg',
    2: 'summer-squash-2-seedling.svg',
    3: 'summer-squash-3-vegetative.svg',
    4: 'summer-squash-4-flowering.svg',
    5: 'summer-squash-5-harvest.svg',
  },
  'sweet-basil': {
    1: 'sweet-basil-1-seed.svg',
    2: 'sweet-basil-2-seedling.svg',
    3: 'sweet-basil-3-vegetative.svg',
    4: 'sweet-basil-4-sizing.svg',
    5: 'sweet-basil-5-harvest.svg',
  },
  'sweet-corn': {
    1: 'sweet-corn-1-seed.svg',
    2: 'sweet-corn-2-seedling.svg',
    3: 'sweet-corn-3-vegetative.svg',
    4: 'sweet-corn-4-flowering.svg',
    5: 'sweet-corn-5-harvest.svg',
  },
  'thyme': {
    1: 'thyme-1-seed.svg',
    2: 'thyme-2-seedling.svg',
    3: 'thyme-3-vegetative.svg',
    4: 'thyme-4-sizing.svg',
    5: 'thyme-5-harvest.svg',
  },
  'tomato': {
    1: 'tomato-1-seed.svg',
    2: 'tomato-2-seedling.svg',
    3: 'tomato-3-vegetative.svg',
    4: 'tomato-4-flowering.svg',
    5: 'tomato-5-harvest.svg',
  },
  'watermelon': {
    1: 'watermelon-1-seed.svg',
    2: 'watermelon-2-seedling.svg',
    3: 'watermelon-3-vegetative.svg',
    4: 'watermelon-4-flowering.svg',
    5: 'watermelon-5-harvest.svg',
  },
};

// Stage 4 file suffix -> crop class: fruiting crops flower, root and leaf
// crops size up, brassicas head up.
const STAGE4_CLASS: Record<string, CropClass> = {
  flowering: 'F',
  sizing: 'L',
  heading: 'B',
};

// Own-property lookup so keys like "toString" never match Object.prototype.
function entryFor(key: string | null): Record<Stage, string> | null {
  if (key === null || !Object.prototype.hasOwnProperty.call(ILLUSTRATIONS, key)) return null;
  return ILLUSTRATIONS[key];
}

export function cropClass(key: string | null): CropClass | null {
  const entry = entryFor(key);
  if (!entry) return null;
  const match = /-4-([a-z]+)\.svg$/.exec(entry[4]);
  return match && Object.prototype.hasOwnProperty.call(STAGE4_CLASS, match[1])
    ? STAGE4_CLASS[match[1]]
    : null;
}

export function illustrationUrl(key: string | null, stage: Stage): string | null {
  const entry = entryFor(key);
  return entry ? `/illustrations/${entry[stage]}` : null;
}

// Catalogue cards and the seed detail view show the stage 5 (Harvest-Ready)
// drawing. A path or https URL is used as is; anything else gets null.
export function catalogueArtUrl(key: string | null): string | null {
  if (entryFor(key)) return illustrationUrl(key, 5);
  if (key !== null && (key.startsWith('/') || key.startsWith('https://'))) return key;
  return null;
}
