import type { PoolClient } from 'pg';
import type { Profile } from 'passport-google-oauth20';
import { db } from '../db';
import { encryptToBuffer } from '../crypto';
import { logger } from '../logger';
import { migrateGuestData, revokeAccountSessions } from '../sessions';
import { LOCATION_NOT_SET } from '../constants';
import { TERMS_VERSION } from '../legal';
import { decideSignup, joinedVia } from '../beta';
import { generateRawToken, hashToken } from '../tokens';
import { sendPasswordRemovedNotice } from '../accountSecurity';
import {
  billingSettledNotDisplaced,
  displaceAccount,
  finishDisplacement,
  settleDisplacedBilling,
  type SettledBilling,
} from '../displacement';
import { alertNewAccount, recordOwnerEvent } from '../ownerAlerts';
import type { OAuthUser } from './providers/google';

export class OAuthUnverifiedEmailError extends Error {
  constructor() {
    super('OAuth provider email is not verified');
    this.name = 'OAuthUnverifiedEmailError';
  }
}

export class OAuthLinkRequiresPasswordError extends Error {
  constructor() {
    super('Google is not authoritative for this address; sign in with a password');
    this.name = 'OAuthLinkRequiresPasswordError';
  }
}

export class OAuthNotInvitedError extends Error {
  constructor() {
    super('This email address is not on the beta invite list');
    this.name = 'OAuthNotInvitedError';
  }
}

// The sign-in proved the inbox of an unverified account: the person must say
// whether they created it. `token` is the raw pending-takeover token (sent in
// the URL); `browserToken` goes in a cookie, binding the takeover to this browser.
export class OAuthTakeoverChoiceRequired extends Error {
  constructor(
    readonly token: string,
    readonly browserToken: string,
  ) {
    super('Ask whether the person created this account');
    this.name = 'OAuthTakeoverChoiceRequired';
  }
}

// The pending-takeover token is unknown, used or expired.
export class OAuthTakeoverInvalidError extends Error {
  constructor() {
    super('Invalid or expired takeover token');
    this.name = 'OAuthTakeoverInvalidError';
  }
}

// The unverified account changed between the answer and the transaction.
export class OAuthTakeoverChangedError extends Error {
  constructor() {
    super('Unverified account changed during sign-in');
    this.name = 'OAuthTakeoverChangedError';
  }
}

export type TakeoverChoice = 'mine' | 'not_mine';

export const TAKEOVER_MINUTES = 15;
// Stripe is settled before the transaction; a held sign-in this close to
// expiry could run out in between.
const MIN_TAKEOVER_MINUTES_FOR_DISPLACEMENT = 2;

const GOOGLE_MAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

// Google only controls the inboxes it hosts: Gmail, or a Workspace domain (the
// profile's hd claim). For any other address its email_verified may be stale,
// so it can create a new account but not take over an existing one.
function providerVouchesForEmail(profile: Profile, email: string): boolean {
  const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase();
  if (GOOGLE_MAIL_DOMAINS.has(domain)) return true;
  const hd = (profile._json as { hd?: unknown } | undefined)?.hd;
  return typeof hd === 'string' && hd.toLowerCase() === domain;
}

function providerEmailVerified(profile: Profile): boolean {
  const fromEmails = (profile.emails?.[0] as { verified?: boolean | string } | undefined)?.verified;
  if (fromEmails !== undefined) return fromEmails === true || fromEmails === 'true';
  const fromJson = (profile._json as { email_verified?: boolean | string } | undefined)?.email_verified;
  return fromJson === true || fromJson === 'true';
}

// A provider sign-in as stored: from the callback, or from a pending takeover.
interface ProviderLogin {
  provider: string;
  providerUserId: string;
  email: string | null;
  emailVerified: boolean;
  vouches: boolean;
  displayName: string;
  avatarUrl: string | null;
  encAccess: Buffer;
  encRefresh: Buffer | null;
}

function loginFrom(oauthUser: OAuthUser): ProviderLogin {
  const { provider, profile, accessToken, refreshToken } = oauthUser;
  const email = profile.emails?.[0]?.value?.toLowerCase() ?? null;
  return {
    provider,
    providerUserId: profile.id,
    email,
    emailVerified: providerEmailVerified(profile),
    vouches: email !== null && providerVouchesForEmail(profile, email),
    displayName: profile.displayName || email?.split('@')[0] || 'Grower',
    avatarUrl: profile.photos?.[0]?.value ?? null,
    encAccess: encryptToBuffer(accessToken),
    encRefresh: refreshToken ? encryptToBuffer(refreshToken) : null,
  };
}

interface ResolveOptions {
  guestSessionId: string | null;
  // null from the callback: an unverified match is held as a pending takeover.
  choice: TakeoverChoice | null;
  // The unverified account the answer is about, and (for 'not_mine') the one whose billing was settled.
  expectedId: number | null;
  settledId: number | null;
  returnTo: string;
}

type Resolution =
  // passwordRemoved: an existing account's password was removed by the claim;
  // the caller emails `email` once the transaction has committed.
  // newAccountAlert: a plain new account (not a takeover); the caller sends the
  // owner alert after the commit.
  | {
      kind: 'resolved';
      accountId: number;
      isNew: boolean;
      displacedId: number | null;
      passwordRemoved: boolean;
      email: string | null;
      newAccountAlert: boolean;
    }
  | { kind: 'pending'; token: string; browserToken: string };

// Maps a provider login to an account, inside the caller's transaction.
// - Known identity → that account.
// - Provider says the email is unverified → refuse (never match by email).
// - Email matches an existing account but Google doesn't host that address
//   (not Gmail, no matching Workspace hd) → refuse; the user signs in with a password.
// - Email matches an UNVERIFIED account → the provider has proven the inbox,
//   but the account may still be the owner's own. Nothing changes yet: the
//   sign-in is held as a pending takeover and the person is asked whether
//   they created the account (completeOAuthTakeover).
//   - 'mine' → claimed in place, as below for a verified account, and verified.
//   - 'not_mine' → displaced (see displacement.ts): deleted, its address
//     freed, its billing refunded, and the owner gets a brand-new account as
//     a normal sign-up below. The sign-up decision and Stripe come first: a
//     refusal or a Stripe failure leaves the account untouched.
// - Email matches a VERIFIED account with a password → claimed in place:
//   password and pending changes removed, every session revoked, Terms and
//   beta terms acceptance cleared and claimed_at set, so the terms gate holds
//   the owner until they accept them again. Only on the first link: afterwards
//   the known identity matches first. Cost: an owner who adds Google later
//   loses their password (Forgot password sets one again) and re-accepts the
//   Terms and beta terms.
// - Email matches a verified account with no password (Google-only, or already
//   claimed) → plain link.
// - No match → new account, if the invite gate allows it (decideSignup);
//   otherwise refuse. An invited email or a qualifying guest becomes a beta
//   participant. Sign-ins to an existing account are never gated.
async function resolveWithin(client: PoolClient, login: ProviderLogin, opts: ResolveOptions): Promise<Resolution> {
  const { provider, providerUserId, email, displayName, avatarUrl, encAccess, encRefresh } = login;

  const identityRow = await client.query<{ account_id: string }>(
    'SELECT account_id FROM oauth_identities WHERE provider = $1 AND provider_user_id = $2',
    [provider, providerUserId],
  );

  if (identityRow.rows.length > 0) {
    const accountId = Number(identityRow.rows[0].account_id);
    await client.query(
      `UPDATE oauth_identities
       SET access_token_encrypted = $1, refresh_token_encrypted = $2,
           token_expires_at = NOW() + INTERVAL '1 hour', updated_at = NOW()
       WHERE provider = $3 AND provider_user_id = $4`,
      [encAccess, encRefresh, provider, providerUserId],
    );
    return {
      kind: 'resolved',
      accountId,
      isNew: false,
      displacedId: null,
      passwordRemoved: false,
      email,
      newAccountAlert: false,
    };
  }

  // accounts.email is NOT NULL, so a profile without a (verified) email cannot sign in.
  if (!email || !login.emailVerified) {
    throw new OAuthUnverifiedEmailError();
  }

  let accountId: number | null = null;
  let displacedId: number | null = null;
  let passwordRemoved = false;

  const existing = await client.query<{ id: string; email_verified: boolean; has_password: boolean }>(
    'SELECT id, email_verified, password_hash IS NOT NULL AS has_password FROM accounts WHERE email = $1 FOR UPDATE',
    [email],
  );

  if (existing.rows.length > 0) {
    if (!login.vouches) {
      throw new OAuthLinkRequiresPasswordError();
    }
    const { email_verified: verified, has_password: hasPassword } = existing.rows[0];
    const existingId = Number(existing.rows[0].id);
    if (!verified && opts.choice === null) {
      const token = generateRawToken();
      const browserToken = generateRawToken();
      await client.query(
        `INSERT INTO pending_takeovers
           (token_hash, account_id, provider, provider_user_id, email, display_name, avatar_url,
            access_token_encrypted, refresh_token_encrypted, guest_session_id, return_to, expires_at,
            browser_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW() + make_interval(mins => $12), $13)`,
        [
          hashToken(token),
          existingId,
          provider,
          providerUserId,
          email,
          displayName,
          avatarUrl,
          encAccess,
          encRefresh,
          opts.guestSessionId,
          opts.returnTo,
          TAKEOVER_MINUTES,
          hashToken(browserToken),
        ],
      );
      return { kind: 'pending', token, browserToken };
    }
    // Rechecked under the lock: the answer is only about the account it was
    // asked about. One that appeared since fails this attempt.
    if (!verified && existingId !== opts.expectedId) throw new OAuthTakeoverChangedError();
    if (!verified && opts.choice === 'not_mine') {
      // Only the account whose billing was settled can be displaced.
      if (existingId !== opts.settledId) throw new OAuthTakeoverChangedError();
      displacedId = existingId;
    } else {
      accountId = existingId;
      // A verified account with a password, or an unverified one the person says is theirs.
      if (hasPassword || !verified) {
        await client.query(
          `UPDATE accounts
              SET password_hash = NULL, pending_email = NULL, email_verified = true,
                  terms_version = NULL, terms_accepted_at = NULL, claimed_at = NOW(),
                  beta_terms_version = NULL, beta_terms_accepted_at = NULL, updated_at = NOW()
            WHERE id = $1`,
          [accountId],
        );
        await client.query('DELETE FROM password_reset_tokens WHERE account_id = $1', [accountId]);
        await client.query('DELETE FROM email_change_tokens WHERE account_id = $1', [accountId]);
        await client.query('DELETE FROM email_verification_tokens WHERE account_id = $1', [accountId]);
        await client.query('DELETE FROM pending_takeovers WHERE account_id = $1', [accountId]);
        await revokeAccountSessions(client, accountId);
        passwordRemoved = hasPassword;
        logger.warn('Account claimed via OAuth sign-in', { accountId, provider, wasVerified: verified });
      }
    }
  }

  const isNew = accountId === null;
  if (accountId === null) {
    // Decided before any displacement, so a refusal changes nothing.
    const decision = await decideSignup(client, email, opts.guestSessionId);
    if (!decision.allowed) throw new OAuthNotInvitedError();
    if (displacedId !== null) await displaceAccount(client, displacedId);
    // Beta terms are not recorded here; the terms gate holds a new participant until they accept.
    const newAccount = await client.query<{ id: string }>(
      `INSERT INTO accounts (email, display_name, email_verified, zone, zone_location_label, terms_version, terms_accepted_at,
                             beta_participant_at, beta_joined_via)
       VALUES ($1, $2, true, 'unknown', $3, $4, NOW(), CASE WHEN $5::boolean THEN NOW() END,
               CASE WHEN $5::boolean THEN $6::text END) RETURNING id`,
      [email, displayName, LOCATION_NOT_SET, TERMS_VERSION, decision.participant, joinedVia(decision)],
    );
    accountId = Number(newAccount.rows[0].id);
    await recordOwnerEvent('account_created', client);
    if (displacedId !== null) await recordOwnerEvent('takeover', client);
  }

  await client.query(
    `INSERT INTO oauth_identities
       (account_id, provider, provider_user_id, email, display_name, avatar_url,
        access_token_encrypted, refresh_token_encrypted, token_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW() + INTERVAL '1 hour')`,
    [accountId, provider, providerUserId, email, displayName, avatarUrl, encAccess, encRefresh],
  );

  // For brand-new accounts only: migrate guest data inside this transaction
  if (isNew && opts.guestSessionId) {
    await migrateGuestData(client, opts.guestSessionId, accountId);
  }

  return {
    kind: 'resolved',
    accountId,
    isNew,
    displacedId,
    passwordRemoved,
    email,
    newAccountAlert: isNew && displacedId === null,
  };
}

async function inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// The OAuth callback. guestSessionId only when the browser isn't signed in to
// an account. Throws OAuthTakeoverChoiceRequired (after storing the pending
// takeover) when the person must first say whether an unverified account is theirs.
export async function resolveOAuthAccount(
  oauthUser: OAuthUser,
  guestSessionId?: string | null,
  returnTo = '/',
): Promise<{ accountId: number; isNew: boolean }> {
  const login = loginFrom(oauthUser);
  const result = await inTransaction((client) =>
    resolveWithin(client, login, { guestSessionId: guestSessionId ?? null, choice: null, expectedId: null, settledId: null, returnTo }),
  );
  if (result.kind === 'pending') throw new OAuthTakeoverChoiceRequired(result.token, result.browserToken);
  // After the commit; the notice never throws, so mail can't fail the sign-in.
  if (result.passwordRemoved && result.email) await sendPasswordRemovedNotice(result.email);
  // In the background, so a slow mail server can't hold the sign-in. Never throws.
  if (result.newAccountAlert) void alertNewAccount('Google');
  return { accountId: result.accountId, isNew: result.isNew };
}

interface PendingTakeover {
  id: number;
  account_id: number;
  provider: string;
  provider_user_id: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  access_token_encrypted: Buffer;
  refresh_token_encrypted: Buffer | null;
  guest_session_id: string | null;
  return_to: string;
  minutes_left: number;
}

// Both halves must match: the token from the URL and the cookie set on the
// browser the sign-in came back to. A row without browser_hash never matches.
async function findPendingTakeover(rawToken: string, browserToken: string | null): Promise<PendingTakeover | null> {
  if (!browserToken) return null;
  const { rows } = await db.query<PendingTakeover>(
    `SELECT *, EXTRACT(EPOCH FROM (expires_at - NOW())) / 60 AS minutes_left
       FROM pending_takeovers
      WHERE token_hash = $1 AND browser_hash = $2 AND expires_at > NOW()`,
    [hashToken(rawToken), hashToken(browserToken)],
  );
  return rows[0] ?? null;
}

// The address a pending takeover is about, or null when the token is invalid,
// expired, or held for another browser.
export async function inspectOAuthTakeover(
  rawToken: string,
  browserToken: string | null,
): Promise<{ email: string } | null> {
  const pending = await findPendingTakeover(rawToken, browserToken);
  return pending ? { email: pending.email } : null;
}

// Completes a held Google sign-in with the person's answer. Single use. The
// account is rechecked: if it was verified or changed meanwhile, the normal
// rules above apply instead. Stripe errors propagate with nothing changed and
// the token still usable.
export async function completeOAuthTakeover(
  rawToken: string,
  browserToken: string | null,
  choice: TakeoverChoice,
): Promise<{ accountId: number; isNew: boolean; guestSessionId: string | null; returnTo: string }> {
  const pending = await findPendingTakeover(rawToken, browserToken);
  if (!pending) throw new OAuthTakeoverInvalidError();
  const login: ProviderLogin = {
    provider: pending.provider,
    providerUserId: pending.provider_user_id,
    email: pending.email,
    // Both were checked by the callback that stored the takeover.
    emailVerified: true,
    vouches: true,
    displayName: pending.display_name,
    avatarUrl: pending.avatar_url,
    encAccess: pending.access_token_encrypted,
    encRefresh: pending.refresh_token_encrypted,
  };
  const guestSessionId = pending.guest_session_id;

  // 'not_mine': settled outside the transaction, Stripe first, and only while
  // the account is still the unverified holder of that address.
  let settled: SettledBilling | null = null;
  if (choice === 'not_mine') {
    const { rows } = await db.query(
      `SELECT 1 FROM accounts
        WHERE id = $1 AND email = $2 AND NOT email_verified
          AND NOT EXISTS (SELECT 1 FROM oauth_identities WHERE provider = $3 AND provider_user_id = $4)`,
      [pending.account_id, pending.email, pending.provider, pending.provider_user_id],
    );
    if (rows.length > 0) {
      if (Number(pending.minutes_left) < MIN_TAKEOVER_MINUTES_FOR_DISPLACEMENT) throw new OAuthTakeoverInvalidError();
      const precheck = await db.connect();
      try {
        if (!(await decideSignup(precheck, pending.email, guestSessionId)).allowed) throw new OAuthNotInvitedError();
      } finally {
        precheck.release();
      }
      try {
        settled = await settleDisplacedBilling(db, pending.account_id);
      } catch (err) {
        logger.error('Could not settle billing for a displaced account; sign-in refused', err, {
          accountId: pending.account_id,
          provider: pending.provider,
        });
        throw err;
      }
    }
  }

  let displacedId: number | null = null;
  let result: { accountId: number; isNew: boolean };
  try {
    const resolved = await inTransaction(async (client) => {
      const { rows } = await client.query(
        'SELECT 1 FROM pending_takeovers WHERE id = $1 AND expires_at > NOW() FOR UPDATE',
        [pending.id],
      );
      if (rows.length === 0) throw new OAuthTakeoverInvalidError();
      await client.query('DELETE FROM pending_takeovers WHERE id = $1', [pending.id]);
      return resolveWithin(client, login, {
        guestSessionId,
        choice,
        expectedId: pending.account_id,
        settledId: settled?.accountId ?? null,
        returnTo: pending.return_to,
      });
    });
    // A choice is given, so the sign-in is never held again.
    if (resolved.kind !== 'resolved') throw new Error('Takeover unexpectedly held again');
    displacedId = resolved.displacedId;
    // Committed: sent before the billing follow-up, so a later throw can't skip
    // it. The notice never throws, so mail can't fail the sign-in.
    if (resolved.passwordRemoved && resolved.email) await sendPasswordRemovedNotice(resolved.email);
    if (resolved.newAccountAlert) void alertNewAccount('Google');
    result = { accountId: resolved.accountId, isNew: resolved.isNew };
  } finally {
    if (settled && displacedId !== settled.accountId) await billingSettledNotDisplaced(settled.accountId);
  }
  if (settled && displacedId !== null) await finishDisplacement(settled, { provider: pending.provider });
  return { ...result, guestSessionId, returnTo: pending.return_to };
}
