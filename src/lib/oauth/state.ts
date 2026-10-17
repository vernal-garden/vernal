import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { safeReturnTo } from './returnTo';

export const OAUTH_NONCE_COOKIE = '_vernal_oauth_nonce';
const NONCE_PATTERN = /^[0-9a-f]{32}$/;

export const OAUTH_NONCE_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env.NODE_ENV === 'production',
};

export function buildOAuthState(nonce: string, returnTo: unknown): string {
  return Buffer.from(JSON.stringify({ nonce, returnTo: safeReturnTo(returnTo) })).toString('base64url');
}

// Runs before passport on the OAuth callback: the state's nonce must match the
// cookie set when this browser started the flow. Missing state is a failure —
// otherwise an attacker can replay their own authorization code into a
// victim's browser (login CSRF). Stores the sanitised returnTo in res.locals.
export function verifyOAuthState(req: Request, res: Response, next: NextFunction): void {
  const cookieNonce = req.cookies?.[OAUTH_NONCE_COOKIE] as unknown;
  const rawState = req.query.state;
  res.clearCookie(OAUTH_NONCE_COOKIE, OAUTH_NONCE_COOKIE_OPTIONS);

  const fail = () => res.redirect(`${process.env.FRONTEND_URL}/login?error=oauth_csrf`);

  if (typeof rawState !== 'string' || typeof cookieNonce !== 'string' || !NONCE_PATTERN.test(cookieNonce)) {
    fail();
    return;
  }

  let decoded: { nonce?: unknown; returnTo?: unknown };
  try {
    decoded = JSON.parse(Buffer.from(rawState, 'base64url').toString('utf8')) as typeof decoded;
  } catch {
    fail();
    return;
  }

  const nonce = decoded?.nonce;
  if (
    typeof nonce !== 'string' ||
    !NONCE_PATTERN.test(nonce) ||
    !crypto.timingSafeEqual(Buffer.from(nonce), Buffer.from(cookieNonce))
  ) {
    fail();
    return;
  }

  res.locals.returnTo = safeReturnTo(decoded.returnTo);
  next();
}
