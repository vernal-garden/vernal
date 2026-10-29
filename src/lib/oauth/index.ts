import passport from 'passport';
import { configureGoogleStrategy } from './providers/google';
import { getServerConfig } from '../serverConfig';

export function initPassport(): void {
  // Disable session serialization — we use our own session system
  passport.serializeUser((user, done) => done(null, user));
  passport.deserializeUser((user, done) => done(null, user as Express.User));

  // The Google strategy throws on a blank client ID, so skip it when sign-in is off.
  if (getServerConfig().googleSignIn) {
    configureGoogleStrategy(passport);
  }
  // Future providers:
  // configureGithubStrategy(passport);
  // configureAppleStrategy(passport);
}

export { passport };
