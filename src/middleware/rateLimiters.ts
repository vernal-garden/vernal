import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { Request, RequestHandler } from 'express';
import { verifySignedToken, COOKIE_NAME } from '../lib/sessions';
import { logger } from '../lib/logger';

// Explicit key generator — express-rate-limit falls back to req.ip on its own,
// but with trust proxy set we want that dependency spelled out rather than implicit.
// See VULN-5 comment in src/index.ts for why req.ip is safe to key on here.
// Routed through express-rate-limit's own ipKeyGenerator so IPv6 addresses are
// normalized to a /56 subnet (its default) instead of keying per-address (else a single IPv6
// client can rotate through its assigned block to dodge the limit entirely).
export const byIp = (req: Request) => ipKeyGenerator(req.ip ?? 'unknown');

// Every request in the test suite originates from the same loopback IP, so a
// per-IP cap that's meaningful against a real attacker is exhausted almost
// immediately by unrelated test files. Limiters that use this skip under test;
// a test that exercises a limiter sets ENFORCE_RATE_LIMITS=true for its duration.
// Production behavior (the actual max/window) is unchanged.
const skipInTest = () => process.env.NODE_ENV === 'test' && process.env.ENFORCE_RATE_LIMITS !== 'true';

const TOO_MANY = { error: 'Too many requests — please try again later' };

// Per-IP limiter for one public auth route. Each route gets its own instance,
// so register, forgot-password and verify-email traffic can't use up login's
// allowance (or each other's).
function authRouteLimiter(max: number): RequestHandler {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: byIp,
    skip: skipInTest,
    message: TOO_MANY,
  });
}

export const registerLimiter = authRouteLimiter(10);
export const forgotPasswordLimiter = authRouteLimiter(10);
export const verifyEmailLimiter = authRouteLimiter(10);

interface LoginLimiterOptions {
  ipMax: number;
  pairMax: number;
  emailMax: number;
  windowMs: number;
  skip?: () => boolean;
}

// Trimmed, lowercased and capped at 254 characters (the longest valid address),
// so an oversized body can't mint unbounded keys.
function normaliseLoginEmail(email: string): string {
  return email.trim().toLowerCase().slice(0, 254);
}

// The login email, normalised, or null when the body has none.
function loginEmail(req: Request): string | null {
  const email = (req.body as { email?: unknown } | undefined)?.email;
  return typeof email === 'string' && email.trim() ? normaliseLoginEmail(email) : null;
}

export interface LoginLimiters {
  handlers: RequestHandler[];
  // Clears an address's lockout: its pair bucket for this request's IP and the
  // address-wide bucket. Called after a successful password reset.
  reset(email: string, req: Request): void;
}

// POST /api/auth/login, in order: per IP, per email+IP pair (strict), per
// email across IPs (looser). Only failed attempts count (skipSuccessfulRequests),
// so a household or CGNAT network sharing an IP isn't locked out by normal use;
// refused (429) attempts don't count either, so hammering a locked address
// doesn't use up the IP's allowance for others. A request one limiter refuses
// never reaches the next, so one IP adds at most pairMax failures to an
// address: locking a user out takes several networks, while guessing spread
// across many IPs is still capped per account. Same shape as the
// forgot-password quota. In-memory: fine for one pm2 instance, needs a shared
// store to scale out.
export function makeLoginLimiters(opts: LoginLimiterOptions): LoginLimiters {
  const skip = opts.skip ?? (() => false);
  const limiter = (
    name: 'ip' | 'pair' | 'email',
    max: number,
    key: (req: Request) => string,
    standardHeaders: boolean,
  ) =>
    rateLimit({
      windowMs: opts.windowMs,
      max,
      standardHeaders,
      legacyHeaders: false,
      keyGenerator: key,
      skipSuccessfulRequests: true,
      requestWasSuccessful: (_req, res) => res.statusCode < 400 || res.statusCode === 429,
      skip,
      message: TOO_MANY,
      // Same 429 as the default handler, plus a warning (never the address)
      // so lockouts show up in the log.
      handler: (req, res, _next, options) => {
        logger.warn('Login rate limited', { limiter: name, ip: req.ip });
        res.status(options.statusCode).json(options.message);
      },
    });
  const pairKey = (email: string, req: Request) => `pair:${email}|${byIp(req)}`;
  const emailKey = (email: string) => `email:${email}`;
  const perIp = limiter('ip', opts.ipMax, (req) => `ip:${byIp(req)}`, true);
  const perPair = limiter('pair', opts.pairMax, (req) => {
    const email = loginEmail(req);
    return email ? pairKey(email, req) : `noemail:${byIp(req)}`;
  }, false);
  const perEmail = limiter('email', opts.emailMax, (req) => {
    const email = loginEmail(req);
    return email ? emailKey(email) : `noemail:${byIp(req)}`;
  }, false);
  return {
    handlers: [perIp, perPair, perEmail],
    reset(email, req) {
      const normalised = normaliseLoginEmail(email);
      perPair.resetKey(pairKey(normalised, req));
      perEmail.resetKey(emailKey(normalised));
    },
  };
}

export const loginLimiters = makeLoginLimiters({
  ipMax: 30,
  pairMax: 5,
  emailMax: 20,
  windowMs: 15 * 60 * 1000,
  skip: skipInTest,
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

// Accounts are keyed by account id and guests by session id, so guests sharing
// a network don't share a budget; no session falls back to IP.
export function writeLimiterKey(req: Request): string {
  if (req.session?.account?.id != null) return `user:${req.session.account.id}`;
  if (req.session) return `session:${req.session.id}`;
  return byIp(req);
}

// Garden/bed/planting writes (POST/PATCH/DELETE).
export const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: writeLimiterKey,
  message: TOO_MANY,
});

// POST /api/events/batch — on top of writeLimiter. 50 events per batch, so 30
// batches a minute caps a session at ~1500 rows/min.
export function makeEventsBatchLimiter(opts: { max: number; windowMs: number; skip?: () => boolean }): RequestHandler {
  return rateLimit({
    windowMs: opts.windowMs,
    max: opts.max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: Request) => (req.session ? `session:${req.session.id}` : `ip:${byIp(req)}`),
    skip: opts.skip,
    message: TOO_MANY,
  });
}
export const eventsBatchLimiter = makeEventsBatchLimiter({ max: 30, windowMs: 60 * 1000, skip: skipInTest });

// POST /api/weather/test-connection — each call fetches from Tempest.
export function makeWeatherTestLimiter(opts: { max: number; windowMs: number; skip?: () => boolean }): RequestHandler {
  return rateLimit({
    windowMs: opts.windowMs,
    max: opts.max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: Request) => `user:${req.session?.account?.id ?? 'none'}`,
    skip: opts.skip,
    message: { error: 'Too many connection tests — please try again later' },
  });
}
export const weatherTestLimiter = makeWeatherTestLimiter({ max: 10, windowMs: 60 * 60 * 1000, skip: skipInTest });

// POST /api/me/verify-email/resend — keyed per account (route requires auth).
export const verificationResendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => `user:${req.session?.account?.id ?? 'none'}`,
  message: { error: 'Too many verification emails — please try again later' },
});

// The raw session token when the cookie's HMAC verifies — no DB lookup, so this
// is safe to run before the session middleware.
function signedSessionToken(req: Request): string | null {
  return verifySignedToken(req.cookies?.[COOKIE_NAME]);
}

interface ApiLimiterOptions {
  sessionMax: number;
  ipMax: number;
  ceilingMax: number;
  windowMs: number;
  skip?: () => boolean;
}

// Global /api limiters. A request with a validly signed cookie is counted per
// session (higher limit); anything else per IP. A separate per-IP ceiling stops
// one IP from rotating through many sessions.
export function makeApiLimiters(opts: ApiLimiterOptions): RequestHandler[] {
  const skip = opts.skip ?? (() => false);
  const ceiling = rateLimit({
    windowMs: opts.windowMs,
    max: opts.ceilingMax,
    standardHeaders: false,
    legacyHeaders: false,
    keyGenerator: (req: Request) => `ip:${byIp(req)}`,
    skip,
    message: { error: 'Too many requests — please try again later' },
  });
  const main = rateLimit({
    windowMs: opts.windowMs,
    max: (req: Request) => (signedSessionToken(req) ? opts.sessionMax : opts.ipMax),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req: Request) => {
      const token = signedSessionToken(req);
      return token ? `sid:${token}` : `ip:${byIp(req)}`;
    },
    skip,
    message: { error: 'Too many requests — please try again later' },
  });
  return [ceiling, main];
}

export const apiLimiters = makeApiLimiters({
  sessionMax: 600,
  ipMax: 300,
  ceilingMax: 1500,
  windowMs: 60 * 1000,
  skip: skipInTest,
});

// POST /api/auth/guest — new guest sessions per IP. A request that already has
// a session gets its existing session back and is not counted.
export const guestCreateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: byIp,
  skip: (req: Request) => skipInTest() || req.session != null,
  // A failed create (e.g. DB outage → 500) shouldn't burn a shared network's allowance.
  skipFailedRequests: true,
  message: { error: 'Too many new visitors from your network — please try again in a few minutes' },
});

// POST /api/feedback — each submission emails the owner, so cap it per session
// and, separately, per IP (a script can mint many guest sessions).
export const feedbackSessionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => `session:${req.session?.id ?? 'none'}`,
  skip: skipInTest,
  message: { error: 'Thanks — you’ve sent a lot of feedback recently. Please try again later.' },
});

export const feedbackIpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: byIp,
  skip: skipInTest,
  message: { error: 'Thanks — you’ve sent a lot of feedback recently. Please try again later.' },
});

// PATCH /api/me/email — each request emails an arbitrary address.
export const emailChangeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => `user:${req.session?.account?.id ?? 'none'}`,
  skip: skipInTest,
  message: { error: 'Too many email change requests — please try again later' },
});

// PATCH /api/me/password — each attempt runs bcrypt, and a stolen cookie could
// otherwise guess the current password. Only failed attempts count.
export const passwordChangeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => `user:${req.session?.account?.id ?? 'none'}`,
  skipSuccessfulRequests: true,
  skip: skipInTest,
  message: { error: 'Too many password change attempts — please try again later' },
});

// POST /api/subscription/checkout — each request can create Stripe objects.
export const checkoutLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => `user:${req.session?.account?.id ?? 'none'}`,
  skip: skipInTest,
  message: { error: 'Too many checkout attempts — please try again later' },
});

// POST /api/auth/forgot-password — send quotas, spent only when a reset email
// is actually about to go out (never for unknown addresses or deduped
// repeats). Two tiers: a strict cap per requester (email + IP pair) and a
// looser per-address backstop against mail-bombing from many IPs. Because the
// strict cap is per pair, one attacker IP cannot lock a victim out of resets.
// In-memory (single pm2 process).
const RESET_PER_EMAIL_IP_PER_DAY = 5;
const RESET_PER_EMAIL_PER_DAY = 20;
const RESET_WINDOW_MS = 24 * 60 * 60 * 1000;
const RESET_MAX_KEYS = 50_000;
const resetHits = new Map<string, number[]>();

function recentHits(key: string, now: number): number[] {
  return (resetHits.get(key) ?? []).filter((t) => now - t < RESET_WINDOW_MS);
}

// Re-insert so Map order tracks recency; evict the stalest keys past the cap.
function storeHits(key: string, hits: number[]): void {
  resetHits.delete(key);
  resetHits.set(key, hits);
  while (resetHits.size > RESET_MAX_KEYS) {
    const oldest = resetHits.keys().next().value;
    if (oldest === undefined) break;
    resetHits.delete(oldest);
  }
}

export function consumeResetEmailQuota(email: string, ip: string, now = Date.now()): boolean {
  if (skipInTest()) return true;
  const normalized = email.trim().toLowerCase();
  const pairKey = `pair:${normalized}|${ip}`;
  const emailKey = `email:${normalized}`;
  const pair = recentHits(pairKey, now);
  const all = recentHits(emailKey, now);
  if (pair.length >= RESET_PER_EMAIL_IP_PER_DAY || all.length >= RESET_PER_EMAIL_PER_DAY) {
    storeHits(pairKey, pair);
    storeHits(emailKey, all);
    return false;
  }
  pair.push(now);
  all.push(now);
  storeHits(pairKey, pair);
  storeHits(emailKey, all);
  return true;
}

// Test helper — empties the quota map.
export function clearResetEmailQuota(): void {
  resetHits.clear();
}
