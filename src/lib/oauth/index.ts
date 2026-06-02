import passport from 'passport';
import { configureGoogleStrategy } from './providers/google';

export function initPassport(): void {
  // Disable session serialization — we use our own session system
  passport.serializeUser((user, done) => done(null, user));
  passport.deserializeUser((user, done) => done(null, user as Express.User));

  configureGoogleStrategy(passport);
  // Future providers:
  // configureGithubStrategy(passport);
  // configureAppleStrategy(passport);
}

export { passport };
