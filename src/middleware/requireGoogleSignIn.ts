import type { NextFunction, Request, Response } from 'express';
import { getServerConfig } from '../lib/serverConfig';

// For the Google OAuth routes. Runs before the state check and passport, which
// would throw "Unknown authentication strategy" when the strategy isn't registered.
export function requireGoogleSignIn(_req: Request, res: Response, next: NextFunction): void {
  if (!getServerConfig().googleSignIn) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  next();
}
