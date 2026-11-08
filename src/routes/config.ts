import { Router, Request, Response } from 'express';
import { getServerConfig } from '../lib/serverConfig';
import { getBetaSettings } from '../lib/beta';

const router = Router();

// Public: tells the client which optional features this server has switched on.
router.get('/', async (_req: Request, res: Response): Promise<void> => {
  const config = getServerConfig();
  const beta = await getBetaSettings();
  res.set('Cache-Control', 'no-cache');
  res.json({
    billing: config.billing === 'stripe',
    mail: config.mail === 'smtp',
    googleSignIn: config.googleSignIn,
    weather: config.weather,
    betaGate: beta.gateOn,
    guestMode: beta.guestModeOn,
    privateBetaVersion: Date.now() >= config.betaApplicationsCloseAt.getTime() ? 'applications_closed' : 'applications_open',
  });
});

export default router;
