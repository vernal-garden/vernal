import { Request, Response, NextFunction } from 'express';

export const PENDING_DELETION_ERROR = {
  error: 'Your account is scheduled for deletion. Cancel the deletion to make changes.',
  code: 'deletion_scheduled',
};

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Writes an account pending deletion may still make: sign in and out, undo the
// deletion, repeat it (COALESCE keeps the date), take its data, and telemetry
// (deleted at purge anyway). The /api/auth/ prefix below also covers guest-data
// merge/discard, which is fine: that data is purged with the account or kept
// on cancel.
const ALLOWED = new Set([
  'POST /api/me/cancel-deletion',
  'DELETE /api/me',
  'POST /api/me/export',
  'POST /api/events/batch',
]);

// Freezes an account scheduled for deletion: it can read, but every other
// write gets a 409. deletionScheduledAt comes from findSession on every
// request, so this needs no query and is never stale.
export function blockWhilePendingDeletion(req: Request, res: Response, next: NextFunction): void {
  if (READ_METHODS.has(req.method) || !req.session?.account?.deletionScheduledAt) return next();

  const path = req.originalUrl.split('?')[0].replace(/\/+$/, '').toLowerCase();
  if (path.startsWith('/api/auth/') || ALLOWED.has(`${req.method} ${path}`)) return next();

  res.status(409).json(PENDING_DELETION_ERROR);
}
