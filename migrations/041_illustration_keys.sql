-- 041_illustration_keys.sql
-- Phase 69 (plant art): sets cambium.seeds.illustration_key for the N1
-- catalogue crops that have growth-stage art, then copies the key onto
-- personal seeds imported from those Cambium rows where they have none yet.
-- The key names a set of SVGs in client/public/illustrations/; crops whose
-- art is not drawn yet still get a key, and the client shows the plain marker
-- until the files ship. Data only: the previous release never reads
-- illustration_key, so it runs unchanged against these rows.

BEGIN;

UPDATE cambium.seeds cs
SET illustration_key = v.illustration_key,
    updated_at       = NOW()
FROM (VALUES
  ('Tomato',        'tomato'),
  ('Bush Bean',     'bush-bean'),
  ('Basil',         'sweet-basil'),
  ('Cucumber',      'cucumber'),
  ('Pea',           'pea'),
  ('Pepper',        'pepper'),
  ('Pole Bean',     'pole-bean'),
  ('Summer Squash', 'summer-squash'),
  ('Carrot',        'carrot'),
  ('Cilantro',      'cilantro'),
  ('Leaf Lettuce',  'leaf-lettuce'),
  ('Onion',         'onion'),
  ('Rosemary',      'rosemary'),
  ('Spearmint',     'spearmint'),
  ('Parsley',       'parsley'),
  ('Potato',        'potato'),
  ('Pumpkin',       'pumpkin'),
  ('Radish',        'radish'),
  ('Sweet Corn',    'sweet-corn'),
  ('Thyme',         'thyme'),
  ('Watermelon',    'watermelon'),
  ('Spinach',       'spinach'),
  ('Broccoli',      'broccoli'),
  ('Cantaloupe',    'cantaloupe'),
  ('Cabbage',       'cabbage'),
  ('Beet',          'beet'),
  ('Winter Squash', 'winter-squash'),
  ('Collards',      'collards'),
  ('Asparagus',     'asparagus'),
  ('Cauliflower',   'cauliflower'),
  ('Head Lettuce',  'head-lettuce'),
  ('Garlic',        'garlic'),
  ('Eggplant',      'eggplant'),
  ('Strawberry',    'strawberry')
) AS v(common_name, illustration_key)
WHERE cs.common_name = v.common_name;

-- Personal copies: fill only empty keys, so a key set on the personal seed
-- is never overwritten.
UPDATE seeds s
SET illustration_key = cs.illustration_key,
    updated_at       = NOW()
FROM cambium.seeds cs
WHERE s.cambium_source_id = cs.id
  AND s.illustration_key IS NULL
  AND cs.illustration_key IS NOT NULL;

COMMIT;
