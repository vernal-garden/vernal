import type { Profile } from 'passport-google-oauth20';
import { db } from '../db';
import { encryptToBuffer } from '../crypto';
import { logger } from '../logger';
import { migrateGuestData, revokeAccountSessions } from '../sessions';
import { LOCATION_NOT_SET } from '../constants';
import type { OAuthUser } from './providers/google';

export class OAuthUnverifiedEmailError extends Error {
  constructor() {
    super('OAuth provider email is not verified');
    this.name = 'OAuthUnverifiedEmailError';
  }
}

function providerEmailVerified(profile: Profile): boolean {
  const fromEmails = (profile.emails?.[0] as { verified?: boolean | string } | undefined)?.verified;
  if (fromEmails !== undefined) return fromEmails === true || fromEmails === 'true';
  const fromJson = (profile._json as { email_verified?: boolean | string } | undefined)?.email_verified;
  return fromJson === true || fromJson === 'true';
}

// Maps a provider login to an account.
// - Known identity → that account.
// - Provider says the email is unverified → refuse (never match by email).
// - Email matches a verified account → link.
// - Email matches an UNVERIFIED account → the provider has proven the inbox, so
//   it claims the account: password and pending changes removed, every session
//   revoked. This defeats pre-registration of someone else's address.
// - No match → new account.
export async function resolveOAuthAccount(
  oauthUser: OAuthUser,
  guestSessionId?: string | null,
): Promise<{ accountId: number; isNew: boolean }> {
  const { provider, profile, accessToken, refreshToken } = oauthUser;
  const email = profile.emails?.[0]?.value?.toLowerCase() ?? null;
  const displayName = profile.displayName || email?.split('@')[0] || 'Grower';
  const avatarUrl = profile.photos?.[0]?.value ?? null;

  const encAccess = encryptToBuffer(accessToken);
  const encRefresh = refreshToken ? encryptToBuffer(refreshToken) : null;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const identityRow = await client.query<{ account_id: string }>(
      'SELECT account_id FROM oauth_identities WHERE provider = $1 AND provider_user_id = $2',
      [provider, profile.id],
    );

    if (identityRow.rows.length > 0) {
      const accountId = Number(identityRow.rows[0].account_id);
      await client.query(
        `UPDATE oauth_identities
         SET access_token_encrypted = $1, refresh_token_encrypted = $2,
             token_expires_at = NOW() + INTERVAL '1 hour', updated_at = NOW()
         WHERE provider = $3 AND provider_user_id = $4`,
        [encAccess, encRefresh, provider, profile.id],
      );
      await client.query('COMMIT');
      return { accountId, isNew: false };
    }

    // accounts.email is NOT NULL, so a profile without a (verified) email cannot sign in.
    if (!email || !providerEmailVerified(profile)) {
      throw new OAuthUnverifiedEmailError();
    }

    let accountId: number;
    let isNew = false;

    const existing = await client.query<{ id: string; email_verified: boolean }>(
      'SELECT id, email_verified FROM accounts WHERE email = $1 FOR UPDATE',
      [email],
    );

    if (existing.rows.length > 0) {
      accountId = Number(existing.rows[0].id);
      if (!existing.rows[0].email_verified) {
        await client.query(
          `UPDATE accounts
              SET password_hash = NULL, email_verified = true, pending_email = NULL, updated_at = NOW()
            WHERE id = $1`,
          [accountId],
        );
        await client.query('DELETE FROM password_reset_tokens WHERE account_id = $1', [accountId]);
        await client.query('DELETE FROM email_change_tokens WHERE account_id = $1', [accountId]);
        await client.query('DELETE FROM email_verification_tokens WHERE account_id = $1', [accountId]);
        await revokeAccountSessions(client, accountId);
        logger.warn('Unverified account claimed via OAuth sign-in', { accountId, provider });
      }
    } else {
      const newAccount = await client.query<{ id: string }>(
        `INSERT INTO accounts (email, display_name, email_verified, zone, zone_location_label)
         VALUES ($1, $2, true, 'unknown', $3) RETURNING id`,
        [email, displayName, LOCATION_NOT_SET],
      );
      accountId = Number(newAccount.rows[0].id);
      isNew = true;
    }

    await client.query(
      `INSERT INTO oauth_identities
         (account_id, provider, provider_user_id, email, display_name, avatar_url,
          access_token_encrypted, refresh_token_encrypted, token_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW() + INTERVAL '1 hour')`,
      [accountId, provider, profile.id, email, displayName, avatarUrl, encAccess, encRefresh],
    );

    // For brand-new accounts only: migrate guest data inside this transaction
    if (isNew && guestSessionId) {
      await migrateGuestData(client, guestSessionId, accountId);
    }

    await client.query('COMMIT');
    return { accountId, isNew };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
