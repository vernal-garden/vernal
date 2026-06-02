import { Request, Response, NextFunction } from 'express';

// Blocks requests with no valid authenticated session.
// Guests (session.isGuest = true) are treated as unauthenticated.
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.session || req.session.isGuest) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  next();
}

// Blocks non-admin requests. Implies authentication.
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.session || req.session.isGuest || req.session.account?.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
}
