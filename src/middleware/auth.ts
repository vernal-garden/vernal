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

// Passes any valid session (guest or authenticated).
// 401 when no session exists (no cookie, HMAC invalid, or session expired).
export function requireSession(req: Request, res: Response, next: NextFunction): void {
  if (!req.session) {
    res.status(401).json({ error: 'Session required' });
    return;
  }
  next();
}

// Blocks requests from accounts not on the 'supporter' subscription tier.
// Chain after requireAuth — assumes req.session.account exists.
export function requireSupporter(req: Request, res: Response, next: NextFunction): void {
  if (!req.session || req.session.isGuest || req.session.account?.subscriptionTier !== 'supporter') {
    res.status(402).json({ upgrade_required: true });
    return;
  }
  next();
}
