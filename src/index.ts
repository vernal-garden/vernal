import express, { Application } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
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
app.use(helmet());
app.use(
  cors({
    origin: FRONTEND_URL,
    credentials: true,
  }),
);

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
// JSON 404 backstop for any unmatched /api path:
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// ── Start ────────────────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`[vernal] API running → http://localhost:${PORT}`);
    console.log(`[vernal] Environment: ${process.env.NODE_ENV ?? 'development'}`);
  });
}

export default app;
