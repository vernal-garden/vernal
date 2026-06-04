-- Cambium starter seed — development only
-- Run: npm run seed:cambium
-- Safe to re-run: all inserts use ON CONFLICT DO NOTHING

BEGIN;

-- ── Seeds ─────────────────────────────────────────────────────────────────────

INSERT INTO cambium.seeds (
  common_name, scientific_name, plant_family,
  spacing_inches,
  maturity_days_min, maturity_days_max,
  sunlight, watering_needs,
  hardiness_zone_min, hardiness_zone_max,
  frost_tolerance,
  weeks_to_transplant,
  succession_interval_weeks,
  moderation_status, source
)
SELECT common_name, scientific_name, plant_family,
       spacing_inches, maturity_days_min, maturity_days_max,
       sunlight, watering_needs,
       hardiness_zone_min, hardiness_zone_max,
       frost_tolerance, weeks_to_transplant, succession_interval_weeks,
       moderation_status, source
FROM (VALUES
  ('Tomato',      'Solanum lycopersicum',  'Solanaceae',      24::numeric,  60,  85, 'full_sun',      'moderate', '10', '12', 'none',  6,    NULL::int, 'active', 'editorial'),
  ('Carrot',      'Daucus carota',         'Apiaceae',         3::numeric,  70, 100, 'full_sun',      'moderate', '3',  '10', 'light', NULL::int, NULL::int, 'active', 'editorial'),
  ('Garlic',      'Allium sativum',        'Amaryllidaceae',   6::numeric, 240, 270, 'full_sun',      'low',      '4',  '9',  'hard',  NULL::int, NULL::int, 'active', 'editorial'),
  ('Onion',       'Allium cepa',           'Amaryllidaceae',   4::numeric, 100, 120, 'full_sun',      'moderate', '5',  '10', 'light', 10,   NULL::int, 'active', 'editorial'),
  ('Lettuce',     'Lactuca sativa',        'Asteraceae',      10::numeric,  45,  75, 'partial_shade', 'moderate', '4',  '9',  'light', 4,    NULL::int, 'active', 'editorial'),
  ('Basil',       'Ocimum basilicum',      'Lamiaceae',       12::numeric,  60,  75, 'full_sun',      'moderate', '10', '12', 'none',  6,    NULL::int, 'active', 'editorial'),
  ('Green Bean',  'Phaseolus vulgaris',    'Fabaceae',         6::numeric,  50,  65, 'full_sun',      'moderate', '3',  '10', 'none',  NULL::int, NULL::int, 'active', 'editorial'),
  ('Cucumber',    'Cucumis sativus',       'Cucurbitaceae',   18::numeric,  50,  70, 'full_sun',      'high',     '4',  '11', 'none',  3,    NULL::int, 'active', 'editorial'),
  ('Cabbage',     'Brassica oleracea',     'Brassicaceae',    18::numeric,  70, 120, 'full_sun',      'moderate', '1',  '9',  'hard',  6,    NULL::int, 'active', 'editorial'),
  ('Spinach',     'Spinacia oleracea',     'Amaranthaceae',    6::numeric,  37,  50, 'partial_shade', 'moderate', '3',  '9',  'hard',  NULL::int, NULL::int, 'active', 'editorial'),
  ('Pepper',      'Capsicum annuum',       'Solanaceae',      18::numeric,  70,  90, 'full_sun',      'moderate', '9',  '11', 'none',  8,    NULL::int, 'active', 'editorial'),
  ('Pea',         'Pisum sativum',         'Fabaceae',         4::numeric,  60,  70, 'full_sun',      'moderate', '3',  '9',  'light', NULL::int, NULL::int, 'active', 'editorial')
) AS v(common_name, scientific_name, plant_family,
       spacing_inches, maturity_days_min, maturity_days_max,
       sunlight, watering_needs,
       hardiness_zone_min, hardiness_zone_max,
       frost_tolerance, weeks_to_transplant, succession_interval_weeks,
       moderation_status, source)
WHERE NOT EXISTS (
  SELECT 1 FROM cambium.seeds s WHERE s.common_name = v.common_name
);

-- ── Companions ────────────────────────────────────────────────────────────────
-- Relationship is directional: seed_id grown near companion_seed_id.
-- A mutual relationship requires two rows.
-- confidence: 60-90 well-documented, 40-60 moderate evidence

WITH seeds AS (
  SELECT id, common_name FROM cambium.seeds WHERE moderation_status = 'active'
)
INSERT INTO cambium.companions (seed_id, companion_seed_id, relationship, confidence, notes, source)
SELECT s1.id, s2.id, v.rel, v.conf, v.notes, v.src
FROM (VALUES
  -- Tomato
  ('Tomato',      'Basil',       'beneficial',  85, 'Basil repels aphids and whiteflies near tomatoes.',                        NULL),
  ('Tomato',      'Garlic',      'beneficial',  75, 'Garlic repels spider mites with volatile sulfur compounds.',               NULL),
  ('Tomato',      'Carrot',      'beneficial',  70, 'Carrots loosen soil around tomato roots.',                                 NULL),
  ('Tomato',      'Onion',       'beneficial',  65, 'Onions deter aphids near tomatoes.',                                       NULL),
  ('Tomato',      'Cabbage',     'antagonistic',70, 'Brassicas and tomatoes inhibit each other via root exudates.',             NULL),
  ('Tomato',      'Cucumber',    'antagonistic',55, 'Both are heavy feeders attracting similar pests.',                         NULL),

  -- Basil
  ('Basil',       'Tomato',      'beneficial',  85, 'Basil volatile oils repel aphids, whiteflies, and tomato hornworm.',       NULL),
  ('Basil',       'Pepper',      'beneficial',  70, 'Basil repels aphids near peppers.',                                        NULL),
  ('Basil',       'Cucumber',    'beneficial',  65, 'Basil repels cucumber beetle.',                                            NULL),
  ('Basil',       'Green Bean',  'antagonistic',55, 'Basil volatile compounds may inhibit bean germination.',                   NULL),

  -- Carrot
  ('Carrot',      'Onion',       'beneficial',  80, 'Classic pairing: onion scent deters carrot fly; carrot scent deters onion fly.', NULL),
  ('Carrot',      'Garlic',      'beneficial',  75, 'Garlic volatile compounds repel carrot fly.',                              NULL),
  ('Carrot',      'Tomato',      'beneficial',  70, 'Tomato shade deters carrot fly; volatile compounds help.',                 NULL),
  ('Carrot',      'Pea',         'beneficial',  65, 'Peas fix nitrogen benefiting carrot growth.',                              NULL),
  ('Carrot',      'Green Bean',  'beneficial',  65, 'Beans fix nitrogen; complementary root depths.',                          NULL),
  ('Carrot',      'Lettuce',     'beneficial',  60, 'Complementary root depths for efficient interplanting.',                   NULL),

  -- Garlic
  ('Garlic',      'Tomato',      'beneficial',  75, 'Protects tomatoes from spider mites and fungal diseases.',                 NULL),
  ('Garlic',      'Carrot',      'beneficial',  75, 'Deters carrot fly; carrots do not suppress garlic growth.',               NULL),
  ('Garlic',      'Pepper',      'beneficial',  70, 'Reduces incidence of fungal diseases in peppers.',                        NULL),
  ('Garlic',      'Spinach',     'beneficial',  60, 'General pest deterrence benefits leafy greens.',                          NULL),
  ('Garlic',      'Pea',         'antagonistic',80, 'Allium compounds inhibit nitrogen fixation in legumes.',                  NULL),
  ('Garlic',      'Green Bean',  'antagonistic',80, 'Allium compounds strongly inhibit bean growth.',                          NULL),

  -- Onion
  ('Onion',       'Carrot',      'beneficial',  80, 'Mutual pest deterrence: onion fly and carrot fly both repelled.',          NULL),
  ('Onion',       'Tomato',      'beneficial',  65, 'Onions deter tomato pests; compatible root systems.',                     NULL),
  ('Onion',       'Cucumber',    'beneficial',  60, 'Onions may deter cucumber beetles.',                                      NULL),
  ('Onion',       'Lettuce',     'beneficial',  55, 'Onion scent deters aphids near lettuce.',                                  NULL),
  ('Onion',       'Pea',         'antagonistic',80, 'Allium compounds inhibit nitrogen fixation.',                             NULL),
  ('Onion',       'Green Bean',  'antagonistic',75, 'Onion volatile compounds inhibit bean development.',                      NULL),

  -- Lettuce
  ('Lettuce',     'Carrot',      'beneficial',  65, 'Complementary root depths; carrot foliage shades lettuce in heat.',       NULL),
  ('Lettuce',     'Cucumber',    'beneficial',  70, 'Cucumbers provide shade reducing lettuce bolting.',                       NULL),
  ('Lettuce',     'Spinach',     'beneficial',  60, 'Similar growing conditions; can be succession-planted.',                  NULL),
  ('Lettuce',     'Onion',       'beneficial',  55, 'Onion scent deters aphids on lettuce.',                                   NULL),
  ('Lettuce',     'Cabbage',     'beneficial',  60, 'Lettuce acts as trap crop for aphids near cabbage.',                      NULL),
  ('Lettuce',     'Green Bean',  'beneficial',  55, 'Beans provide light shade and fix nitrogen.',                             NULL),

  -- Green Bean
  ('Green Bean',  'Carrot',      'beneficial',  70, 'Beans fix nitrogen benefiting carrots; different root depths.',           NULL),
  ('Green Bean',  'Cucumber',    'beneficial',  65, 'Beans fix nitrogen cucumbers use; both warm-season.',                    NULL),
  ('Green Bean',  'Spinach',     'beneficial',  60, 'Nitrogen fixation from beans feeds spinach.',                             NULL),
  ('Green Bean',  'Pea',         'beneficial',  60, 'Both legumes; share structures and contribute to soil nitrogen.',         NULL),
  ('Green Bean',  'Onion',       'antagonistic',75, 'Onion compounds inhibit bean nitrogen fixation.',                         NULL),
  ('Green Bean',  'Garlic',      'antagonistic',80, 'Garlic strongly inhibits bean germination.',                              NULL),
  ('Green Bean',  'Basil',       'antagonistic',55, 'Basil volatile oils may inhibit bean development.',                       NULL),

  -- Cucumber
  ('Cucumber',    'Green Bean',  'beneficial',  65, 'Beans fix nitrogen cucumbers use as heavy feeders.',                     NULL),
  ('Cucumber',    'Pea',         'beneficial',  60, 'Pea nitrogen benefits cucumbers; share trellis.',                        NULL),
  ('Cucumber',    'Lettuce',     'beneficial',  70, 'Lettuce grows in partial shade of cucumber vines.',                      NULL),
  ('Cucumber',    'Basil',       'beneficial',  65, 'Basil repels cucumber beetles.',                                          NULL),
  ('Cucumber',    'Onion',       'beneficial',  60, 'Onions may deter cucumber beetles.',                                     NULL),
  ('Cucumber',    'Tomato',      'antagonistic',55, 'Both attract similar pests; competing for resources.',                   NULL),

  -- Cabbage
  ('Cabbage',     'Onion',       'beneficial',  65, 'Onion scent confuses cabbage moth and fly.',                             NULL),
  ('Cabbage',     'Lettuce',     'beneficial',  60, 'Lettuce trap crop draws aphids from cabbage.',                           NULL),
  ('Cabbage',     'Garlic',      'beneficial',  65, 'Garlic deters cabbage aphids and fungal pathogens.',                     NULL),
  ('Cabbage',     'Spinach',     'beneficial',  55, 'Both cool-season; compatible root systems.',                             NULL),
  ('Cabbage',     'Green Bean',  'beneficial',  55, 'Bean nitrogen fixation benefits heavy-feeding cabbage.',                 NULL),
  ('Cabbage',     'Tomato',      'antagonistic',70, 'Tomatoes and brassicas inhibit each other via root exudates.',           NULL),

  -- Spinach
  ('Spinach',     'Pea',         'beneficial',  65, 'Pea nitrogen fixation benefits nitrogen-hungry spinach.',                NULL),
  ('Spinach',     'Green Bean',  'beneficial',  60, 'Bean canopy shade reduces bolting; nitrogen helps.',                    NULL),
  ('Spinach',     'Garlic',      'beneficial',  60, 'Garlic deters aphids and leaf miners attacking spinach.',                NULL),
  ('Spinach',     'Lettuce',     'beneficial',  60, 'Similar requirements; both benefit from cool conditions.',               NULL),
  ('Spinach',     'Cabbage',     'beneficial',  55, 'Both cool-season; complementary canopy heights.',                       NULL),
  ('Spinach',     'Onion',       'beneficial',  55, 'Onion scent deters aphids near spinach.',                               NULL),

  -- Pepper
  ('Pepper',      'Basil',       'beneficial',  70, 'Basil repels aphids and spider mites; both prefer warm.',               NULL),
  ('Pepper',      'Tomato',      'beneficial',  65, 'Compatible space-sharing; tomatoes shelter peppers from wind.',         NULL),
  ('Pepper',      'Garlic',      'beneficial',  70, 'Garlic reduces fungal disease common in peppers.',                      NULL),
  ('Pepper',      'Carrot',      'beneficial',  55, 'Carrots aerate soil around pepper roots.',                              NULL),
  ('Pepper',      'Green Bean',  'beneficial',  55, 'Bean nitrogen benefits peppers.',                                       NULL),
  ('Pepper',      'Cabbage',     'antagonistic',55, 'Brassicas may inhibit pepper growth via allelopathic exudates.',        NULL),

  -- Pea
  ('Pea',         'Carrot',      'beneficial',  70, 'Pea nitrogen fixation significantly benefits carrots.',                 NULL),
  ('Pea',         'Green Bean',  'beneficial',  60, 'Both legumes improve soil nitrogen; different seasons.',                NULL),
  ('Pea',         'Spinach',     'beneficial',  65, 'Pea nitrogen feeds nitrogen-hungry spinach.',                           NULL),
  ('Pea',         'Cucumber',    'beneficial',  60, 'Peas fix nitrogen; cucumbers share trellis.',                          NULL),
  ('Pea',         'Lettuce',     'beneficial',  60, 'Peas provide shade for lettuce; nitrogen improves soil.',              NULL),
  ('Pea',         'Onion',       'antagonistic',80, 'Allium compounds strongly inhibit legume nitrogen fixation.',          NULL),
  ('Pea',         'Garlic',      'antagonistic',80, 'Garlic inhibits pea growth and nitrogen fixation.',                    NULL)
) AS v(plant_name, companion_name, rel, conf, notes, src)
JOIN seeds s1 ON s1.common_name = v.plant_name
JOIN seeds s2 ON s2.common_name = v.companion_name
ON CONFLICT (seed_id, companion_seed_id) DO NOTHING;

COMMIT;
