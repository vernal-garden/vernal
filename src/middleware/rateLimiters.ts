import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { Request } from 'express';

// Explicit key generator — express-rate-limit falls back to req.ip on its own,
// but with trust proxy set we want that dependency spelled out rather than implicit.
// See VULN-5 comment in src/index.ts for why req.ip is safe to key on here.
// Routed through express-rate-limit's own ipKeyGenerator so IPv6 addresses are
// normalized to a /64 subnet instead of keying per-address (else a single IPv6
// client can rotate through its assigned block to dodge the limit entirely).
const byIp = (req: Request) => ipKeyGenerator(req.ip ?? 'unknown');

// Every request in the test suite originates from the same loopback IP, so a
// per-IP login/reset cap that's meaningful against a real attacker (10 per 15
// min) is exhausted almost immediately by unrelated test files that legitimately
// log in many times. Skip these two limiters under test — production behavior
// (the actual max/window below) is unchanged; only counting is bypassed.
const skipInTest = () => process.env.NODE_ENV === 'test';

// /api/auth/login, /api/auth/register, /api/auth/forgot-password
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: byIp,
  skip: skipInTest,
  message: { error: 'Too many requests — please try again later' },
});

// /api/auth/reset-password — tighter limit, this endpoint burns a reset token per guess
export const passwordResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: byIp,
  skip: skipInTest,
  message: { error: 'Too many requests — please try again later' },
});

// Garden/bed/planting writes (POST/PATCH/DELETE) — keyed per authenticated
// account when one exists, falling back to IP for guest sessions.
export const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) =>
    req.session?.account?.id != null ? `user:${req.session.account.id}` : byIp(req),
  message: { error: 'Too many requests — please try again later' },
});
