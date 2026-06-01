import { Request, Response, NextFunction } from 'express';
import { findSession, COOKIE_NAME } from '../lib/sessions';

// Attaches session data to req.session on every request.
// Sets req.session = null if no valid cookie is present.
// Does NOT block unauthenticated requests. That is the job of requireAuth (Phase 06).
export async function sessionMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const signed = req.cookies?.[COOKIE_NAME];

  if (!signed) {
    req.session = null;
    return next();
  }

  try {
    req.session = await findSession(signed);
  } catch {
    req.session = null;
  }

  next();
}
