import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { searchSeeds, listFamilies, getSeedById, getCompanionsForSeed } from '../services/cambium';

const router = Router();

const catalogueLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
});

router.use(catalogueLimiter);

// GET /api/catalogue/families
router.get('/families', async (_req, res) => {
  try {
    const families = await listFamilies();
    res.json({ data: families });
  } catch (err) {
    console.error('listFamilies error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/catalogue/seeds/:id/companions
// (registered before GET /api/catalogue/seeds/:id to prevent route collision)
router.get('/seeds/:id/companions', async (req, res) => {
  const id = req.params.id as string;

  if (!/^\d+$/.test(id)) {
    return res.status(400).json({ error: 'Invalid id' });
  }

  const rawRelationship = req.query.relationship as string | undefined;
  const VALID_RELATIONSHIPS = new Set(['beneficial', 'antagonistic', 'neutral']);

  if (rawRelationship && !VALID_RELATIONSHIPS.has(rawRelationship)) {
    return res.status(400).json({ error: 'Invalid relationship value' });
  }

  try {
    const companions = await getCompanionsForSeed(Number(id), {
      relationship: rawRelationship as 'beneficial' | 'antagonistic' | 'neutral' | undefined,
    });

    if (companions === null) {
      return res.status(404).json({ error: 'Seed not found' });
    }

    res.json({ data: companions });
  } catch (err) {
    console.error('getCompanionsForSeed error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/catalogue/seeds
router.get('/seeds', async (req, res) => {
  try {
    const query = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : undefined;
    const family = typeof req.query.family === 'string' ? req.query.family : undefined;

    const rawLimit = parseInt(req.query.limit as string, 10);
    const rawOffset = parseInt(req.query.offset as string, 10);
    const limit = isNaN(rawLimit) ? 20 : Math.min(Math.max(rawLimit, 1), 50);
    const offset = isNaN(rawOffset) ? 0 : Math.max(rawOffset, 0);

    const { data, total } = await searchSeeds({
      query,
      family,
      limit,
      offset,
    });

    res.json({ data, total, limit, offset });
  } catch (err) {
    console.error('searchSeeds error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/catalogue/seeds/:id
router.get('/seeds/:id', async (req, res) => {
  const id = req.params.id as string;

  if (!/^\d+$/.test(id)) {
    return res.status(400).json({ error: 'Invalid id' });
  }

  try {
    const seed = await getSeedById(Number(id));
    if (!seed) {
      return res.status(404).json({ error: 'Seed not found' });
    }
    res.json(seed);
  } catch (err) {
    console.error('getSeedById error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
