import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { searchPlants, getPlantBySlug, listTags } from '../services/cambium';

const router = Router();

const plantsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
});

router.use(plantsLimiter);

// ---- IMPORTANT: /plants/tags must be registered before /plants/:slug ----

// GET /api/plants/tags
router.get('/plants/tags', async (_req, res) => {
  try {
    const tags = await listTags();
    res.json({ data: tags });
  } catch (err) {
    console.error('listTags error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/plants
router.get('/plants', async (req, res) => {
  try {
    const query = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
    const tagSlug = typeof req.query.tag === 'string' ? req.query.tag.trim() : undefined;

    const rawLimit = parseInt(req.query.limit as string, 10);
    const rawOffset = parseInt(req.query.offset as string, 10);
    const limit = isNaN(rawLimit) ? 20 : Math.min(Math.max(rawLimit, 1), 50);
    const offset = isNaN(rawOffset) ? 0 : Math.max(rawOffset, 0);

    const { data, total } = await searchPlants({
      query: query || '%',
      limit,
      offset,
      tagSlug,
    });

    res.json({ data, total, limit, offset });
  } catch (err) {
    console.error('searchPlants error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/plants/:slug
router.get('/plants/:slug', async (req, res) => {
  const slug = req.params.slug as string;

  if (!/^[a-z0-9-]+$/.test(slug)) {
    return res.status(400).json({ error: 'Invalid slug' });
  }

  try {
    const plant = await getPlantBySlug(slug);
    if (!plant) {
      return res.status(404).json({ error: 'Plant not found' });
    }
    res.json(plant);
  } catch (err) {
    console.error('getPlantBySlug error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
