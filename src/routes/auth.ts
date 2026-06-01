import { Router, Request, Response } from 'express';
import {
  createGuestSession,
  makeSessionCookie,
  clearSessionCookie,
} from '../lib/sessions';

export const authRouter = Router();

// POST /api/auth/guest
// Creates a guest session for first-time visitors with no cookie.
// Idempotent from the client's perspective — if called with an existing valid session,
// we still honour the existing session (the middleware already populated req.session).
authRouter.post('/guest', async (req: Request, res: Response): Promise<void> => {
  // If a valid session already exists, return its state rather than creating a duplicate
  if (req.session) {
    res.json({
      data: {
        isGuest: req.session.isGuest,
        sessionId: req.session.id,
      },
    });
    return;
  }

  const { signedToken, expiresAt } = await createGuestSession();
  makeSessionCookie(signedToken, expiresAt, res);

  res.status(201).json({
    data: {
      isGuest: true,
    },
  });
});

// GET /api/auth/session
// Returns the current session state. Used by the frontend on app load to determine
// whether the user is a guest, authenticated, or unauthenticated.
authRouter.get('/session', (req: Request, res: Response): void => {
  if (!req.session) {
    res.json({ data: { authenticated: false, isGuest: false } });
    return;
  }

  if (req.session.isGuest) {
    res.json({ data: { authenticated: false, isGuest: true } });
    return;
  }

  const { account } = req.session;
  res.json({
    data: {
      authenticated: true,
      isGuest: false,
      account: {
        id: account!.id,
        email: account!.email,
        role: account!.role,
        subscriptionTier: account!.subscriptionTier,
      },
    },
  });
});

// DELETE /api/auth/session
// Clears the session cookie. Guests lose their session; authenticated users are logged out.
// Does not delete the guest_sessions row — expired rows are cleaned up by the nightly job.
authRouter.delete('/session', (req: Request, res: Response): void => {
  clearSessionCookie(res);
  res.json({ data: { success: true } });
});
