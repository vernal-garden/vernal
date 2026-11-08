import type { NextFunction, Request, RequestHandler, Response } from 'express';

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Stripe posts from its own servers and signs the body instead.
const EXEMPT_PATHS = new Set(['/api/webhooks/stripe']);

const REFUSED = { error: 'Cross-site request refused.' };

function originOf(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

// Login CSRF guard. The session cookie is SameSite=Lax, which still lets a
// cross-site form POST through with the attacker's credentials, signing the
// victim's browser into the attacker's account. State-changing requests are
// refused when the browser says they came from another site (Sec-Fetch-Site)
// or from an origin we don't serve. Requests with neither header (curl,
// server-to-server, tests) pass: only browsers send them, and a browser
// always sends Origin on a cross-origin POST.
export function makeSameOriginGuard(allowedOrigins: string[]): RequestHandler {
  const allowed = new Set(allowedOrigins.map(originOf).filter((o): o is string => o !== null));
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!UNSAFE_METHODS.has(req.method) || EXEMPT_PATHS.has(req.originalUrl.split('?')[0])) {
      next();
      return;
    }
    if (req.get('sec-fetch-site') === 'cross-site') {
      res.status(403).json(REFUSED);
      return;
    }
    const origin = req.get('origin');
    if (origin !== undefined && !allowed.has(originOf(origin) ?? '')) {
      res.status(403).json(REFUSED);
      return;
    }
    next();
  };
}
