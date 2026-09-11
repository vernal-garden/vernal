import './instrument';
import express, { Application } from 'express';
import * as Sentry from '@sentry/node';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import cron from 'node-cron';
import { logger } from './lib/logger';
import { runNightlyJob } from './jobs/nightly';
import { healthRouter } from './routes/health';
import { authRouter } from './routes/auth';
import catalogueRouter from './routes/catalogue';
import gardensRouter from './routes/gardens';
import { plantingsNestedRouter, gardenPlantingsRouter, plantingsFlatRouter } from './routes/plantings';
import { soilNestedRouter, soilFlatRouter } from './routes/soil';
import { amendmentsNestedRouter, amendmentsFlatRouter } from './routes/amendments';
import meRouter from './routes/me';
import seedsRouter from './routes/seeds';
import correctionsRouter from './routes/corrections';
import weatherRouter from './routes/weather';
import subscriptionRouter, { handleStripeWebhook } from './routes/subscription';
import adminRouter from './routes/admin';
import { sessionMiddleware } from './middleware/session';
import { initPassport, passport } from './lib/oauth/index';

dotenv.config();

// ── App setup ─────────────────────────────────────────────────────────────────

const app: Application = express();

// Behind Nginx (Phase 04). Nginx appends the client IP via
// $proxy_add_x_forwarded_for; trust exactly one hop so req.ip is the real
// client and rate limiters key per-IP. Port 3000 is firewalled (ufw) —
// the header cannot reach Express except through Nginx. (VULN-5 pattern.)
app.set('trust proxy', 1);

const PORT = Number(process.env.PORT) || 3000;
const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:5173';

// ── Security ─────────────────────────────────────────────────────────────────
// This server returns JSON only — it never serves HTML, so there's nothing for
// a CSP to allow. Deny every fetch directive; this also blocks XSS payloads
// from doing anything useful if one ever gets reflected into an error body.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        scriptSrc: ["'none'"],
        styleSrc: ["'none'"],
        imgSrc: ["'none'"],
        connectSrc: ["'self'"],
        frameSrc: ["'none'"],
        objectSrc: ["'none'"],
      },
    },
  }),
);
app.use(
  cors({
    origin: FRONTEND_URL,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  }),
);

// ── Stripe webhook ───────────────────────────────────────────────────────────
// Must be mounted before express.json() — Stripe signature verification
// requires the raw, unparsed request body.
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), handleStripeWebhook);

// ── Body parsing ─────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(sessionMiddleware);
initPassport();
app.use(passport.initialize());

// ── Routes ───────────────────────────────────────────────────────────────────
app.use('/health', healthRouter);
app.use('/api/auth', authRouter);
app.use('/api/catalogue', catalogueRouter);
app.use('/api/gardens/:gardenId/beds/:bedId/plantings', plantingsNestedRouter);
app.use('/api/gardens/:gardenId/plantings', gardenPlantingsRouter);
app.use('/api/gardens/:gardenId/soil-readings', soilNestedRouter);
app.use('/api/gardens/:gardenId/amendments', amendmentsNestedRouter);
app.use('/api/gardens', gardensRouter);
app.use('/api/plantings', plantingsFlatRouter);
app.use('/api/soil-readings', soilFlatRouter);
app.use('/api/amendments', amendmentsFlatRouter);
app.use('/api/me', meRouter);
app.use('/api/seeds', seedsRouter);
app.use('/api/corrections', correctionsRouter);
app.use('/api/weather', weatherRouter);
app.use('/api/subscription', subscriptionRouter);
app.use('/api/admin', adminRouter);
// JSON 404 backstop for any unmatched /api path:
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

Sentry.setupExpressErrorHandler(app);

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error('Unhandled error', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ────────────────────────────────────────────────────────────────────
// E2E_LISTEN is the one exception to "never listen under NODE_ENV=test": the
// Playwright suite needs a real bound server (unlike Vitest/supertest, which
// import `app` in-process) while still getting test-mode DB/rate-limit behavior.
if (process.env.NODE_ENV !== 'test' || process.env.E2E_LISTEN === 'true') {
  app.listen(PORT, () => {
    logger.info(`API running → http://localhost:${PORT}`);
    logger.info(`Environment: ${process.env.NODE_ENV ?? 'development'}`);
  });

  cron.schedule('0 3 * * *', () => {
    console.log('[nightly] job starting');
    runNightlyJob().catch((err) => console.error('[nightly] job error:', err));
  });
  console.log('[vernal] Nightly job scheduled at 03:00 UTC');

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', reason instanceof Error ? reason : new Error(String(reason)));
    Sentry.captureException(reason);
    void Sentry.flush(2000).finally(() => process.exit(1));
  });
}

export default app;
