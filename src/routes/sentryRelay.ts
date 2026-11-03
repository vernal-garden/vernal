import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { logger } from '../lib/logger';
import { getServerConfig, parseSentryDsn, type SentryRelayTarget } from '../lib/serverConfig';
import { relayLimiter } from '../middleware/rateLimiters';

// POST /api/relay — the browser SDK's `tunnel`. Ad blockers block Sentry's
// ingest host, so the client posts its envelopes here and we pass them on.
// Only envelopes whose header names our project (SENTRY_CLIENT_DSN) are
// forwarded, and the upstream URL is built from the config, never from the
// envelope, so this can't be used to reach anything else. No visitor IP or
// request headers are forwarded.

export const RELAY_TIMEOUT_MS = 10_000;

// Sentry's answer headers the SDK acts on (its own rate limiting). Its
// Content-Type is not passed: we answer text/plain, the SDK ignores the body.
const PASSED_HEADERS = ['retry-after', 'x-sentry-rate-limits'];

// True when the envelope's first line is a JSON object whose dsn names the target.
export function envelopeMatches(body: Buffer, target: SentryRelayTarget): boolean {
  const newline = body.indexOf(0x0a);
  const headerLine = (newline === -1 ? body : body.subarray(0, newline)).toString('utf8');
  let header: unknown;
  try {
    header = JSON.parse(headerLine);
  } catch {
    return false;
  }
  const dsn = typeof header === 'object' && header !== null ? (header as { dsn?: unknown }).dsn : undefined;
  if (typeof dsn !== 'string') return false;
  const parsed = parseSentryDsn(dsn);
  return (
    parsed !== null &&
    parsed.host === target.host &&
    parsed.projectId === target.projectId &&
    parsed.publicKey === target.publicKey
  );
}

// Relay off (no SENTRY_CLIENT_DSN): answer like any unknown /api path, before
// reading the body.
function requireRelay(_req: Request, res: Response, next: NextFunction): void {
  if (getServerConfig().sentryRelay) next();
  else res.status(404).json({ error: 'Not found' });
}

export function createSentryRelayRouter(opts: { timeoutMs: number }): Router {
  const router = Router();
  router.post(
    '/',
    requireRelay,
    relayLimiter,
    // Raw bytes so the envelope is forwarded exactly. inflate: false — no
    // compressed bodies (GHSA-27r3-jxmh-p828); they get a 415.
    express.raw({ type: () => true, limit: '1mb', inflate: false }),
    async (req: Request, res: Response): Promise<void> => {
      const target = getServerConfig().sentryRelay as SentryRelayTarget;
      const body: unknown = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0 || !envelopeMatches(body, target)) {
        res.status(400).json({ error: 'Invalid envelope' });
        return;
      }

      // Plain setTimeout (as in lib/weather/upstream.ts); covers the body read too.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
      // Browser went away before we answered: stop the upstream call.
      res.on('close', () => {
        if (!res.writableEnded) controller.abort();
      });
      try {
        const upstream = await fetch(`https://${target.host}/api/${target.projectId}/envelope/`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-sentry-envelope' },
          body: new Uint8Array(body),
          signal: controller.signal,
          // Never follow a redirect off the configured host; it lands in the 502 path.
          redirect: 'error',
        });
        const text = await upstream.text();
        for (const name of PASSED_HEADERS) {
          const value = upstream.headers.get(name);
          if (value !== null) res.setHeader(name, value);
        }
        // With VITE_API_BASE_URL set the client is cross-origin and these aren't CORS-safelisted.
        res.setHeader('Access-Control-Expose-Headers', 'Retry-After, X-Sentry-Rate-Limits');
        res.status(upstream.status).type('text/plain').send(text);
      } catch (err) {
        logger.warn('Sentry relay failed', { errMsg: err instanceof Error ? err.message : String(err) });
        res.status(502).json({ error: 'Relay failed' });
      } finally {
        clearTimeout(timer);
      }
    },
  );
  return router;
}

export const sentryRelayRouter = createSentryRelayRouter({ timeoutMs: RELAY_TIMEOUT_MS });
