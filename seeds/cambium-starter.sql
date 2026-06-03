-- Cambium starter seed — development only
-- Run: npm run seed:cambium
-- Safe to re-run: all inserts use ON CONFLICT DO NOTHING

BEGIN;

-- ── Tags ──────────────────────────────────────────────────────────────────────

INSERT INTO cambium.tags (slug, label, category) VALUES
  ('vegetable',    'Vegetable',      'crop_type'),
  ('herb',         'Herb',           'crop_type'),
  ('fruit',        'Fruit',          'crop_type'),
  ('root',         'Root Vegetable', 'crop_type'),
  ('leafy-green',  'Leafy Green',    'crop_type'),
  ('allium',       'Allium',         'plant_family'),
  ('brassica',     'Brassica',       'plant_family'),
  ('nightshade',   'Nightshade',     'plant_family'),
  ('cucurbit',     'Cucurbit',       'plant_family'),
  ('legume',       'Legume',         'plant_family')
ON CONFLICT (slug) DO NOTHING;

-- ── Plants ────────────────────────────────────────────────────────────────────

INSERT INTO cambium.plants (slug, botanical_name, common_names, description, family, genus, species, is_published) VALUES
  ('solanum-lycopersicum',
   'Solanum lycopersicum',
   ARRAY['Tomato'],
   'One of the most popular garden vegetables worldwide. Warm-season crop that produces red, orange, or yellow fruits. Requires full sun, regular water, and support for indeterminate varieties.',
   'Solanaceae', 'Solanum', 'lycopersicum', true),

  ('daucus-carota',
   'Daucus carota subsp. sativus',
   ARRAY['Carrot'],
   'Root vegetable grown for its sweet, crunchy taproot. Prefers deep, loose, stone-free soil. Best in cool seasons; direct-sow as seeds do not transplant well.',
   'Apiaceae', 'Daucus', 'carota', true),

  ('allium-sativum',
   'Allium sativum',
   ARRAY['Garlic'],
   'Pungent bulb used widely in cooking and as a natural pest deterrent in the garden. Plant cloves in autumn for a summer harvest.',
   'Amaryllidaceae', 'Allium', 'sativum', true),

  ('allium-cepa',
   'Allium cepa',
   ARRAY['Onion', 'Bulb Onion'],
   'Versatile bulb vegetable grown from sets, transplants, or seed. Long-day varieties suit northern climates; short-day varieties suit the south.',
   'Amaryllidaceae', 'Allium', 'cepa', true),

  ('lactuca-sativa',
   'Lactuca sativa',
   ARRAY['Lettuce', 'Garden Lettuce'],
   'Cool-season leafy green that bolts in heat. Suitable for cut-and-come-again harvests. Grows well in partial shade during summer.',
   'Asteraceae', 'Lactuca', 'sativa', true),

  ('ocimum-basilicum',
   'Ocimum basilicum',
   ARRAY['Basil', 'Sweet Basil'],
   'Aromatic warm-season herb closely associated with Italian cuisine. Sensitive to cold; plant after last frost. Pinch flowers to prolong leaf production.',
   'Lamiaceae', 'Ocimum', 'basilicum', true),

  ('phaseolus-vulgaris',
   'Phaseolus vulgaris',
   ARRAY['Green Bean', 'Common Bean', 'Snap Bean'],
   'Warm-season legume available in bush and pole varieties. Fixes atmospheric nitrogen, benefiting neighbouring plants. Direct-sow after last frost.',
   'Fabaceae', 'Phaseolus', 'vulgaris', true),

  ('cucumis-sativus',
   'Cucumis sativus',
   ARRAY['Cucumber'],
   'Warm-season cucurbit that thrives in heat and full sun. Needs consistent moisture and benefits from vertical support. Direct-sow or transplant after last frost.',
   'Cucurbitaceae', 'Cucumis', 'sativus', true),

  ('brassica-oleracea-capitata',
   'Brassica oleracea var. capitata',
   ARRAY['Cabbage'],
   'Cool-season brassica grown for its dense leafy head. Heavy feeder; prefers fertile soil. Succession planting extends harvest from spring through autumn.',
   'Brassicaceae', 'Brassica', 'oleracea', true),

  ('spinacia-oleracea',
   'Spinacia oleracea',
   ARRAY['Spinach'],
   'Fast-growing cool-season leafy green rich in iron and folate. Bolts quickly in long days; grow in spring and autumn. Tolerates light frost.',
   'Amaranthaceae', 'Spinacia', 'oleracea', true),

  ('capsicum-annuum',
   'Capsicum annuum',
   ARRAY['Pepper', 'Sweet Pepper', 'Bell Pepper'],
   'Warm-season nightshade producing sweet or hot fruits. Requires a long growing season; start indoors 8–10 weeks before last frost. Full sun essential.',
   'Solanaceae', 'Capsicum', 'annuum', true),

  ('pisum-sativum',
   'Pisum sativum',
   ARRAY['Pea', 'Garden Pea', 'English Pea'],
   'Cool-season legume sown early in spring or autumn. Fixes nitrogen; improves soil for following crops. Needs support for climbing varieties.',
   'Fabaceae', 'Pisum', 'sativum', true)
ON CONFLICT (slug) DO NOTHING;

-- ── Growing Attributes ────────────────────────────────────────────────────────

INSERT INTO cambium.growing_attributes (
  plant_id,
  days_to_germination_min, days_to_germination_max,
  days_to_maturity_min,    days_to_maturity_max,
  spacing_cm_min,          spacing_cm_max,
  row_spacing_cm,
  plant_height_cm_min,     plant_height_cm_max,
  sun_requirements,        water_requirements,
  frost_hardy, direct_sow, transplant
)
SELECT id,  6,  14,  60,  85, 45, 90,  90,  90, 180, 'full_sun',     'moderate', false, false, true  FROM cambium.plants WHERE slug = 'solanum-lycopersicum'
UNION ALL
SELECT id,  7,  21,  70, 100,  5, 10,  30,  15,  30, 'full_sun',     'moderate', true,  true,  false FROM cambium.plants WHERE slug = 'daucus-carota'
UNION ALL
SELECT id, 14,  21, 240, 270, 15, 20,  30,  30,  60, 'full_sun',     'low',      true,  true,  false FROM cambium.plants WHERE slug = 'allium-sativum'
UNION ALL
SELECT id,  7,  14, 100, 120, 10, 15,  30,  30,  60, 'full_sun',     'moderate', true,  false, true  FROM cambium.plants WHERE slug = 'allium-cepa'
UNION ALL
SELECT id,  7,  14,  45,  75, 20, 30,  30,  15,  30, 'partial_shade','moderate', true,  true,  true  FROM cambium.plants WHERE slug = 'lactuca-sativa'
UNION ALL
SELECT id,  5,  10,  60,  75, 15, 30,  30,  30,  60, 'full_sun',     'moderate', false, false, true  FROM cambium.plants WHERE slug = 'ocimum-basilicum'
UNION ALL
SELECT id,  6,  14,  50,  65, 10, 15,  45,  30,  60, 'full_sun',     'moderate', false, true,  false FROM cambium.plants WHERE slug = 'phaseolus-vulgaris'
UNION ALL
SELECT id,  6,  10,  50,  70, 30, 60,  90,  30,  60, 'full_sun',     'high',     false, true,  true  FROM cambium.plants WHERE slug = 'cucumis-sativus'
UNION ALL
SELECT id,  7,  12,  70,  90, 45, 60,  60,  30,  60, 'full_sun',     'moderate', true,  false, true  FROM cambium.plants WHERE slug = 'brassica-oleracea-capitata'
UNION ALL
SELECT id,  7,  14,  37,  50, 15, 20,  30,  15,  30, 'partial_shade','moderate', true,  true,  true  FROM cambium.plants WHERE slug = 'spinacia-oleracea'
UNION ALL
SELECT id, 10,  21,  70,  90, 45, 60,  60,  45,  90, 'full_sun',     'moderate', false, false, true  FROM cambium.plants WHERE slug = 'capsicum-annuum'
UNION ALL
SELECT id,  6,  14,  60,  70, 10, 15,  30,  60, 180, 'full_sun',     'moderate', true,  true,  false FROM cambium.plants WHERE slug = 'pisum-sativum'
ON CONFLICT (plant_id) DO NOTHING;

-- ── Soil Preferences ──────────────────────────────────────────────────────────

INSERT INTO cambium.soil_preferences (
  plant_id,
  ph_min, ph_max,
  nitrogen_demand, phosphorus_demand, potassium_demand,
  moisture_preference, drainage
)
SELECT id, 6.0, 6.8, 'high',   'high',     'high',     'moist',         'well-drained' FROM cambium.plants WHERE slug = 'solanum-lycopersicum'
UNION ALL
SELECT id, 6.0, 6.8, 'low',    'moderate', 'moderate', 'moist',         'well-drained' FROM cambium.plants WHERE slug = 'daucus-carota'
UNION ALL
SELECT id, 6.0, 7.0, 'low',    'moderate', 'moderate', 'moderate',      'well-drained' FROM cambium.plants WHERE slug = 'allium-sativum'
UNION ALL
SELECT id, 6.0, 7.0, 'moderate','moderate','moderate', 'moderate',      'well-drained' FROM cambium.plants WHERE slug = 'allium-cepa'
UNION ALL
SELECT id, 6.0, 7.0, 'moderate','moderate','moderate', 'moist',         'well-drained' FROM cambium.plants WHERE slug = 'lactuca-sativa'
UNION ALL
SELECT id, 6.0, 7.0, 'moderate','moderate','moderate', 'moist',         'well-drained' FROM cambium.plants WHERE slug = 'ocimum-basilicum'
UNION ALL
SELECT id, 6.0, 7.0, 'low',    'moderate', 'moderate', 'moist',         'well-drained' FROM cambium.plants WHERE slug = 'phaseolus-vulgaris'
UNION ALL
SELECT id, 6.0, 7.0, 'moderate','moderate','high',     'moist',         'well-drained' FROM cambium.plants WHERE slug = 'cucumis-sativus'
UNION ALL
SELECT id, 6.5, 7.5, 'high',   'moderate', 'high',     'moist',         'well-drained' FROM cambium.plants WHERE slug = 'brassica-oleracea-capitata'
UNION ALL
SELECT id, 6.5, 7.5, 'moderate','moderate','moderate', 'moist',         'well-drained' FROM cambium.plants WHERE slug = 'spinacia-oleracea'
UNION ALL
SELECT id, 6.0, 6.8, 'moderate','high',    'high',     'moist',         'well-drained' FROM cambium.plants WHERE slug = 'capsicum-annuum'
UNION ALL
SELECT id, 6.0, 7.5, 'low',    'moderate', 'moderate', 'moderate',      'well-drained' FROM cambium.plants WHERE slug = 'pisum-sativum'
ON CONFLICT (plant_id) DO NOTHING;

-- ── Companion Data ────────────────────────────────────────────────────────────
-- Relationship is directional: plant_id grown near companion_plant_id
-- confidence: 60–90 well-documented, 40–60 moderate evidence

INSERT INTO cambium.companion_data (plant_id, companion_plant_id, relationship, confidence, notes, source)
SELECT p1.id, p2.id, v.rel, v.conf, v.notes, v.src
FROM (VALUES
  -- Tomato companions
  ('solanum-lycopersicum', 'ocimum-basilicum',           'beneficial',  85, 'Basil repels aphids and whiteflies; anecdotal evidence of improved tomato flavour.', 'Carrots Love Tomatoes (Riotte, 1975)'),
  ('solanum-lycopersicum', 'daucus-carota',              'beneficial',  70, 'Carrots loosen soil around tomato roots; tomatoes shade carrot foliage.', 'Carrots Love Tomatoes (Riotte, 1975)'),
  ('solanum-lycopersicum', 'allium-sativum',             'beneficial',  75, 'Garlic repels spider mites and other pests with its volatile sulfur compounds.', 'Companion Planting for Pest Management (Altieri, 1994)'),
  ('solanum-lycopersicum', 'allium-cepa',                'beneficial',  65, 'Onions deter aphids and other soft-bodied insects near tomatoes.', NULL),
  ('solanum-lycopersicum', 'brassica-oleracea-capitata', 'antagonistic',70, 'Brassicas and tomatoes compete strongly for resources; allelopathic compounds may inhibit each other.', 'Vegetables Love Each Other (Experton, 2019)'),
  ('solanum-lycopersicum', 'cucumis-sativus',            'antagonistic',55, 'Both are heavy feeders and attract similar pests; can lead to increased pest pressure when grown together.', NULL),

  -- Carrot companions
  ('daucus-carota', 'allium-cepa',                'beneficial',  80, 'Classic pairing: onion scent deters carrot fly; carrot scent deters onion fly.', 'Carrots Love Tomatoes (Riotte, 1975)'),
  ('daucus-carota', 'allium-sativum',             'beneficial',  75, 'Garlic volatile compounds repel carrot fly.', NULL),
  ('daucus-carota', 'pisum-sativum',              'beneficial',  65, 'Peas fix nitrogen which benefits carrot growth; carrots do not compete with pea roots.', NULL),
  ('daucus-carota', 'lactuca-sativa',             'beneficial',  60, 'Lettuce and carrots use different soil layers and can be interplanted efficiently.', NULL),
  ('daucus-carota', 'solanum-lycopersicum',       'beneficial',  70, 'Tomato plants provide partial shade; volatile compounds from tomatoes deter carrot fly.', 'Carrots Love Tomatoes (Riotte, 1975)'),
  ('daucus-carota', 'phaseolus-vulgaris',         'beneficial',  65, 'Beans fix nitrogen; both plants have complementary root depths.', NULL),

  -- Garlic companions
  ('allium-sativum', 'solanum-lycopersicum',       'beneficial',  75, 'Protects tomatoes from spider mites and fungal diseases with volatile sulfur.', NULL),
  ('allium-sativum', 'daucus-carota',              'beneficial',  75, 'Garlic deters carrot fly; carrots do not suppress garlic growth.', NULL),
  ('allium-sativum', 'capsicum-annuum',            'beneficial',  70, 'Garlic reduces incidence of fungal diseases in peppers.', NULL),
  ('allium-sativum', 'spinacia-oleracea',          'beneficial',  60, 'General pest deterrence benefits nearby leafy greens.', NULL),
  ('allium-sativum', 'pisum-sativum',              'antagonistic',80, 'Allium compounds inhibit nitrogen fixation in legumes; stunts pea growth.', 'Rodale''s Ultimate Encyclopedia of Organic Gardening'),
  ('allium-sativum', 'phaseolus-vulgaris',         'antagonistic',80, 'Allium compounds strongly inhibit bean growth and nitrogen fixation.', 'Rodale''s Ultimate Encyclopedia of Organic Gardening'),

  -- Onion companions
  ('allium-cepa', 'daucus-carota',              'beneficial',  80, 'Mutual pest deterrence: onion fly and carrot fly both repelled.', 'Carrots Love Tomatoes (Riotte, 1975)'),
  ('allium-cepa', 'solanum-lycopersicum',       'beneficial',  65, 'Onions deter tomato pests; compatible root systems.', NULL),
  ('allium-cepa', 'cucumis-sativus',            'beneficial',  60, 'Onions may deter cucumber beetles.', NULL),
  ('allium-cepa', 'lactuca-sativa',             'beneficial',  55, 'Good space-efficient interplant; onion upright habit leaves room for lettuce spread.', NULL),
  ('allium-cepa', 'pisum-sativum',              'antagonistic',80, 'Allium compounds inhibit nitrogen fixation; stunts legume growth.', 'Rodale''s Ultimate Encyclopedia of Organic Gardening'),
  ('allium-cepa', 'phaseolus-vulgaris',         'antagonistic',75, 'Onion volatile compounds significantly inhibit bean development.', NULL),

  -- Lettuce companions
  ('lactuca-sativa', 'daucus-carota',              'beneficial',  65, 'Complementary root depths allow efficient interplanting; light shade of carrot foliage benefits lettuce in heat.', NULL),
  ('lactuca-sativa', 'cucumis-sativus',            'beneficial',  70, 'Cucumbers provide overhead shade that reduces lettuce bolting in summer.', NULL),
  ('lactuca-sativa', 'spinacia-oleracea',          'beneficial',  60, 'Similar growing conditions; can be succession-planted or interplanted.', NULL),
  ('lactuca-sativa', 'allium-cepa',                'beneficial',  55, 'Onion scent deters aphids that frequently attack lettuce.', NULL),
  ('lactuca-sativa', 'brassica-oleracea-capitata', 'beneficial',  60, 'Lettuce acts as a trap crop for aphids, drawing them away from cabbage.', 'Companion Planting for Pest Management'),
  ('lactuca-sativa', 'phaseolus-vulgaris',         'beneficial',  55, 'Beans provide light shade and fix nitrogen; lettuce fills space below bean canopy.', NULL),

  -- Basil companions
  ('ocimum-basilicum', 'solanum-lycopersicum',       'beneficial',  85, 'Basil volatile oils repel aphids, whiteflies, and tomato hornworm moth. Classic garden pairing.', 'Carrots Love Tomatoes (Riotte, 1975)'),
  ('ocimum-basilicum', 'capsicum-annuum',            'beneficial',  70, 'Basil repels aphids and improves overall plant vigour near peppers.', NULL),
  ('ocimum-basilicum', 'cucumis-sativus',            'beneficial',  65, 'Basil repels cucumber beetle; both prefer warm conditions.', NULL),
  ('ocimum-basilicum', 'spinacia-oleracea',          'neutral',     50, 'No strong documented benefit or harm; can be interplanted without issue.', NULL),
  ('ocimum-basilicum', 'phaseolus-vulgaris',         'antagonistic',55, 'Some evidence that basil volatile compounds inhibit bean germination and growth.', NULL),

  -- Bean companions
  ('phaseolus-vulgaris', 'daucus-carota',              'beneficial',  70, 'Beans fix nitrogen benefiting heavy-feeding carrots; roots occupy different depths.', NULL),
  ('phaseolus-vulgaris', 'cucumis-sativus',            'beneficial',  65, 'Beans fix nitrogen that cucumbers use; both are warm-season plants.', NULL),
  ('phaseolus-vulgaris', 'spinacia-oleracea',          'beneficial',  60, 'Nitrogen fixation from beans feeds nitrogen-hungry spinach.', NULL),
  ('phaseolus-vulgaris', 'pisum-sativum',              'beneficial',  60, 'Both legumes; can share support structures and contribute to soil nitrogen.', NULL),
  ('phaseolus-vulgaris', 'allium-cepa',                'antagonistic',75, 'Onion compounds inhibit bean root bacteria responsible for nitrogen fixation.', 'Rodale''s Ultimate Encyclopedia of Organic Gardening'),
  ('phaseolus-vulgaris', 'allium-sativum',             'antagonistic',80, 'Garlic strongly inhibits bean germination and growth.', 'Rodale''s Ultimate Encyclopedia of Organic Gardening'),
  ('phaseolus-vulgaris', 'ocimum-basilicum',           'antagonistic',55, 'Basil volatile oils may inhibit bean development.', NULL),

  -- Cucumber companions
  ('cucumis-sativus', 'phaseolus-vulgaris',         'beneficial',  65, 'Beans fix nitrogen that cucumbers utilise as heavy feeders.', NULL),
  ('cucumis-sativus', 'pisum-sativum',              'beneficial',  60, 'Pea nitrogen benefits cucumbers; both can share trellis structures.', NULL),
  ('cucumis-sativus', 'lactuca-sativa',             'beneficial',  70, 'Lettuce grows in the partial shade of cucumber vines; efficient space use.', NULL),
  ('cucumis-sativus', 'ocimum-basilicum',           'beneficial',  65, 'Basil repels cucumber beetles, a key cucumber pest.', NULL),
  ('cucumis-sativus', 'allium-cepa',                'beneficial',  60, 'Onions may deter cucumber beetle and reduce aphid pressure.', NULL),
  ('cucumis-sativus', 'solanum-lycopersicum',       'antagonistic',55, 'Both attract similar pests; competing for resources can reduce yields.', NULL),

  -- Cabbage companions
  ('brassica-oleracea-capitata', 'allium-cepa',                'beneficial',  65, 'Onion scent confuses and deters cabbage moth and cabbage fly.', 'Companion Planting (Philbrick & Gregg, 1966)'),
  ('brassica-oleracea-capitata', 'lactuca-sativa',             'beneficial',  60, 'Lettuce trap crop draws aphids away from cabbage; efficient interplanting.', NULL),
  ('brassica-oleracea-capitata', 'allium-sativum',             'beneficial',  65, 'Garlic deters cabbage aphids and fungal pathogens.', NULL),
  ('brassica-oleracea-capitata', 'spinacia-oleracea',          'beneficial',  55, 'Both cool-season plants; compatible root systems and canopy.', NULL),
  ('brassica-oleracea-capitata', 'phaseolus-vulgaris',         'beneficial',  55, 'Bean nitrogen fixation benefits cabbage, a heavy feeder.', NULL),
  ('brassica-oleracea-capitata', 'solanum-lycopersicum',       'antagonistic',70, 'Tomatoes and brassicas inhibit each other via root exudates and resource competition.', NULL),

  -- Spinach companions
  ('spinacia-oleracea', 'pisum-sativum',              'beneficial',  65, 'Pea nitrogen fixation directly benefits nitrogen-hungry spinach.', NULL),
  ('spinacia-oleracea', 'phaseolus-vulgaris',         'beneficial',  60, 'Bean canopy provides light shade that reduces spinach bolting; nitrogen fixation helps.', NULL),
  ('spinacia-oleracea', 'allium-sativum',             'beneficial',  60, 'Garlic deters aphids and leaf miners that commonly attack spinach.', NULL),
  ('spinacia-oleracea', 'lactuca-sativa',             'beneficial',  60, 'Similar growing requirements; both benefit from cool conditions.', NULL),
  ('spinacia-oleracea', 'brassica-oleracea-capitata', 'beneficial',  55, 'Both cool-season plants with complementary canopy heights.', NULL),
  ('spinacia-oleracea', 'allium-cepa',                'beneficial',  55, 'Onion scent deters aphids and leaf miners near spinach.', NULL),

  -- Pepper companions
  ('capsicum-annuum', 'ocimum-basilicum',           'beneficial',  70, 'Basil repels aphids and spider mites; both prefer warm conditions.', NULL),
  ('capsicum-annuum', 'solanum-lycopersicum',       'beneficial',  65, 'Similar cultural requirements; compatible space-sharing; tomatoes may shelter peppers from wind.', NULL),
  ('capsicum-annuum', 'allium-sativum',             'beneficial',  70, 'Garlic reduces fungal disease pressure common in peppers.', NULL),
  ('capsicum-annuum', 'daucus-carota',              'beneficial',  55, 'Carrots aerate soil around pepper roots; compatible canopy.', NULL),
  ('capsicum-annuum', 'phaseolus-vulgaris',         'beneficial',  55, 'Bean nitrogen fixation benefits peppers; compatible growth habits.', NULL),
  ('capsicum-annuum', 'brassica-oleracea-capitata', 'antagonistic',55, 'Brassicas may inhibit pepper growth through allelopathic root exudates.', NULL),

  -- Pea companions
  ('pisum-sativum', 'daucus-carota',              'beneficial',  70, 'Pea nitrogen fixation significantly benefits carrots; roots occupy different depths.', NULL),
  ('pisum-sativum', 'phaseolus-vulgaris',         'beneficial',  60, 'Both legumes improve soil nitrogen; different seasons reduce competition.', NULL),
  ('pisum-sativum', 'spinacia-oleracea',          'beneficial',  65, 'Pea nitrogen feeds nitrogen-hungry spinach; pea tendrils can use spinach stems for light support.', NULL),
  ('pisum-sativum', 'cucumis-sativus',            'beneficial',  60, 'Peas fix nitrogen; cucumbers can share trellis infrastructure.', NULL),
  ('pisum-sativum', 'lactuca-sativa',             'beneficial',  60, 'Peas provide light shade for lettuce; nitrogen fixation improves soil.', NULL),
  ('pisum-sativum', 'allium-cepa',                'antagonistic',80, 'Allium compounds strongly inhibit legume nitrogen fixation.', 'Rodale''s Ultimate Encyclopedia of Organic Gardening'),
  ('pisum-sativum', 'allium-sativum',             'antagonistic',80, 'Garlic inhibits pea growth and nitrogen fixation.', 'Rodale''s Ultimate Encyclopedia of Organic Gardening')
) AS v(plant_slug, companion_slug, rel, conf, notes, src)
JOIN cambium.plants p1 ON p1.slug = v.plant_slug
JOIN cambium.plants p2 ON p2.slug = v.companion_slug
ON CONFLICT (plant_id, companion_plant_id) DO NOTHING;

-- ── Plant Tags ────────────────────────────────────────────────────────────────

INSERT INTO cambium.plant_tags (plant_id, tag_id)
SELECT p.id, t.id FROM cambium.plants p, cambium.tags t
WHERE (p.slug, t.slug) IN (
  ('solanum-lycopersicum',        'vegetable'),
  ('solanum-lycopersicum',        'nightshade'),
  ('daucus-carota',               'vegetable'),
  ('daucus-carota',               'root'),
  ('allium-sativum',              'vegetable'),
  ('allium-sativum',              'herb'),
  ('allium-sativum',              'allium'),
  ('allium-cepa',                 'vegetable'),
  ('allium-cepa',                 'allium'),
  ('lactuca-sativa',              'vegetable'),
  ('lactuca-sativa',              'leafy-green'),
  ('ocimum-basilicum',            'herb'),
  ('phaseolus-vulgaris',          'vegetable'),
  ('phaseolus-vulgaris',          'legume'),
  ('cucumis-sativus',             'vegetable'),
  ('cucumis-sativus',             'cucurbit'),
  ('brassica-oleracea-capitata',  'vegetable'),
  ('brassica-oleracea-capitata',  'brassica'),
  ('spinacia-oleracea',           'vegetable'),
  ('spinacia-oleracea',           'leafy-green'),
  ('capsicum-annuum',             'vegetable'),
  ('capsicum-annuum',             'nightshade'),
  ('pisum-sativum',               'vegetable'),
  ('pisum-sativum',               'legume')
)
ON CONFLICT DO NOTHING;

COMMIT;
