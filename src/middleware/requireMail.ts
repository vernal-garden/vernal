import type { NextFunction, Request, Response } from 'express';
import { isMailEnabled } from '../lib/serverConfig';

// For routes that only exist to send email. Runs before limiters and any
// other work, so nothing is consumed or changed when mail is off.
export function requireMail(_req: Request, res: Response, next: NextFunction): void {
  if (!isMailEnabled()) {
    res.status(409).json({ error: "Email isn't set up on this server." });
    return;
  }
  next();
}
