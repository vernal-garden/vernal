import { Request, Response, NextFunction } from 'express';

export const BETA_TERMS_ERROR = {
  error: 'Accept the beta terms to continue.',
  code: 'beta_terms_required',
};

export const TERMS_ERROR = {
  error: 'Accept the Terms to continue.',
  code: 'terms_required',
};

// What an account held at the terms screen may still do: sign in and out (the
// /api/auth/ prefix), read the server config, accept the terms, and delete the
// account. Someone who won't accept can also take their data, manage what they
// pay for (not start a new checkout), and undo a deletion. Unlike
// blockWhilePendingDeletion this refuses reads too.
const ALLOWED = new Set([
  'GET /api/config',
  'POST /api/me/terms',
  'POST /api/me/beta-terms',
  'DELETE /api/me',
  'POST /api/me/cancel-deletion',
  'POST /api/me/export',
  'GET /api/me/export',
  'GET /api/me/export/download',
  'GET /api/subscription',
  'POST /api/subscription/portal',
]);

// Holds an account at the terms screen until it accepts what is pending: the
// main Terms after the account was claimed (termsPending), or the current beta
// terms for a participant (betaTermsPending). Both come from findSession on
// every request, so this needs no query and is never stale. When both are
// pending the answer is terms_required, the one the client accepts first.
export function termsGate(req: Request, res: Response, next: NextFunction): void {
  const account = req.session?.account;
  if (account?.termsPending !== true && account?.betaTermsPending !== true) return next();

  const path = req.originalUrl.split('?')[0].replace(/\/+$/, '').toLowerCase();
  if (path.startsWith('/api/auth/') || ALLOWED.has(`${req.method} ${path}`)) return next();

  res.status(403).json(account.termsPending ? TERMS_ERROR : BETA_TERMS_ERROR);
}
