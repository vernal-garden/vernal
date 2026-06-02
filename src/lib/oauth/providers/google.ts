import { Strategy as GoogleStrategy, Profile } from 'passport-google-oauth20';
import type { PassportStatic } from 'passport';

export interface OAuthUser {
  provider: string;
  profile: Profile;
  accessToken: string;
  refreshToken: string | undefined;
}

export function configureGoogleStrategy(passport: PassportStatic): void {
  passport.use(
    new GoogleStrategy(
      {
        clientID: process.env.GOOGLE_CLIENT_ID!,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
        callbackURL: `${process.env.APP_URL}/api/auth/oauth/google/callback`,
      },
      (accessToken, refreshToken, profile, done) => {
        const user: OAuthUser = {
          provider: 'google',
          profile,
          accessToken,
          refreshToken: refreshToken ?? undefined,
        };
        done(null, user);
      }
    )
  );
}
