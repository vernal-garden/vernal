import { Router } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { searchSeeds, listFamilies, getSeedById, getCompanionsForSeed } from '../services/cambium';
import { isNumericId } from '../lib/validation';
import { logger } from '../lib/logger';

const router = Router();

const catalogueLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? 'unknown'),
  message: { error: 'Too many requests' },
});

router.use(catalogueLimiter);

// GET /api/catalogue/families
router.get('/families', async (_req, res) => {
  try {
    const families = await listFamilies();
    res.json({ data: families });
  } catch (err) {
    logger.error('GET /catalogue/families failed', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/catalogue/seeds/:id/companions
// (registered before GET /api/catalogue/seeds/:id to prevent route collision)
router.get('/seeds/:id/companions', async (req, res) => {
  const id = req.params.id as string;

  if (!isNumericId(id)) {
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
    logger.error('GET /catalogue/seeds/:id/companions failed', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/catalogue/seeds
router.get('/seeds', async (req, res) => {
  try {
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : undefined;
    if (query && query.length > 100) {
      return res.status(400).json({ error: 'q must be 100 characters or fewer' });
    }
    const family = typeof req.query.family === 'string' ? req.query.family : undefined;
    const sort = req.query.sort === 'popular' ? ('popular' as const) : undefined;

    const rawLimit = parseInt(req.query.limit as string, 10);
    const rawOffset = parseInt(req.query.offset as string, 10);
    const limit = isNaN(rawLimit) ? 20 : Math.min(Math.max(rawLimit, 1), 50);
    const offset = isNaN(rawOffset) ? 0 : Math.min(Math.max(rawOffset, 0), 10000);

    const { data, total } = await searchSeeds({
      query,
      family,
      limit,
      offset,
      sort,
    });

    res.json({ data, total, limit, offset });
  } catch (err) {
    logger.error('GET /catalogue/seeds failed', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/catalogue/seeds/:id
router.get('/seeds/:id', async (req, res) => {
  const id = req.params.id as string;

  if (!isNumericId(id)) {
    return res.status(400).json({ error: 'Invalid id' });
  }

  try {
    const seed = await getSeedById(Number(id));
    if (!seed) {
      return res.status(404).json({ error: 'Seed not found' });
    }
    res.json(seed);
  } catch (err) {
    logger.error('GET /catalogue/seeds/:id failed', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
