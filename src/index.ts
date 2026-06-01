import express, { Application } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import dotenv from 'dotenv';
import { healthRouter } from './routes/health';

dotenv.config();

// ── App setup ─────────────────────────────────────────────────────────────────

const app: Application = express();
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

// ── Routes ───────────────────────────────────────────────────────────────────
app.use('/health', healthRouter);

// ── Start ────────────────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`[vernal] API running → http://localhost:${PORT}`);
    console.log(`[vernal] Environment: ${process.env.NODE_ENV ?? 'development'}`);
  });
}

export default app;
