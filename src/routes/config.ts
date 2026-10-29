import { Router, Request, Response } from 'express';
import { getServerConfig } from '../lib/serverConfig';

const router = Router();

// Public: tells the client which optional features this server has switched on.
router.get('/', (_req: Request, res: Response): void => {
  const config = getServerConfig();
  res.set('Cache-Control', 'no-cache');
  res.json({
    billing: config.billing === 'stripe',
    mail: config.mail === 'smtp',
    googleSignIn: config.googleSignIn,
    weather: config.weather,
  });
});

export default router;
