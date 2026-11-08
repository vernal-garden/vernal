import { db } from './db';
import { sendMail } from './mailer';
import { revokeAccountSessions } from './sessions';
import { generateRawToken, hashToken } from './tokens';

const VERIFY_HOURS = 24;

// Final text from General Counsel.
const UNVERIFIED_NOTICE =
  "Verifying keeps this account tied to you. Didn't sign up for Vernal? Use the 'This wasn't me' link below and we'll remove the account.";

// Issues a fresh 24h verification link for `email` (replacing any unused one)
// and emails it. Throws if the email can't be sent; callers decide whether
// that's fatal.
export async function sendVerificationEmail(accountId: number, email: string): Promise<void> {
  const rawToken = generateRawToken();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Serialise concurrent requests for the same account so only one live token remains.
    await client.query('SELECT 1 FROM accounts WHERE id = $1 FOR UPDATE', [accountId]);
    await client.query('DELETE FROM email_verification_tokens WHERE account_id = $1 AND used_at IS NULL', [
      accountId,
    ]);
    await client.query(
      `INSERT INTO email_verification_tokens (account_id, email, token_hash, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(hours => $4))`,
      [accountId, email, hashToken(rawToken), VERIFY_HOURS],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await sendMail({ to: email, ...buildVerificationEmail(rawToken) });
}

// The verification email's subject and bodies for a raw token.
export function buildVerificationEmail(rawToken: string): { subject: string; text: string; html: string } {
  const base = process.env.FRONTEND_URL ?? 'http://localhost:5173';
  const verifyUrl = `${base}/verify-email?token=${rawToken}`;
  // Same token: the page only asks; nothing happens until an explicit POST.
  const notMeUrl = `${base}/not-me?token=${rawToken}`;
  return {
    subject: 'Verify your Vernal email address',
    text: `Confirm this is your email address by opening the link below. It expires in ${VERIFY_HOURS} hours.\n\n${verifyUrl}\n\n${UNVERIFIED_NOTICE}\n\nThis wasn't me: ${notMeUrl}`,
    html: `<p>Confirm this is your email address by opening the link below. It expires in ${VERIFY_HOURS} hours.</p><p><a href="${verifyUrl}">${verifyUrl}</a></p><p>${UNVERIFIED_NOTICE}</p><p><a href="${notMeUrl}">This wasn't me</a></p>`,
  };
}

export interface VerificationTokenInfo {
  accountId: number;
  email: string;
  emailVerified: boolean;
  // When the link was issued (the table has no created_at: tokens live VERIFY_HOURS).
  issuedAt: Date;
  minutesLeft: number;
}

// A usable token (unused, unexpired, still the account's current email) and
// its account, without consuming it. Null otherwise.
export async function inspectVerificationToken(rawToken: string): Promise<VerificationTokenInfo | null> {
  const { rows } = await db.query<{
    account_id: number;
    email: string;
    email_verified: boolean;
    issued_at: Date;
    minutes_left: number;
  }>(
    `SELECT t.account_id, a.email, a.email_verified,
            t.expires_at - make_interval(hours => $2) AS issued_at,
            EXTRACT(EPOCH FROM (t.expires_at - now())) / 60 AS minutes_left
       FROM email_verification_tokens t
       JOIN accounts a ON a.id = t.account_id AND a.email = t.email
      WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.expires_at > now()`,
    [hashToken(rawToken), VERIFY_HOURS],
  );
  const row = rows[0];
  return row
    ? {
        accountId: row.account_id,
        email: row.email,
        emailVerified: row.email_verified,
        issuedAt: row.issued_at,
        minutesLeft: Number(row.minutes_left),
      }
    : null;
}

// Marks the account verified if the token is unused, unexpired, and still
// matches the account's current email. Returns false otherwise.
// claim: the answer came from someone not trusted as the account's own
// session, who says they created it. An account still unverified is then also
// claimed: Terms and beta terms cleared and claimed_at set, so whoever
// answered accepts the Terms in their own name; pending email changes and
// held Google sign-ins dropped; every session signed out.
export async function consumeVerificationToken(rawToken: string, opts: { claim?: boolean } = {}): Promise<boolean> {
  const tokenHash = hashToken(rawToken);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Account row first, then the token, the same lock order as the other paths.
    const { rows: ref } = await client.query<{ account_id: number }>(
      'SELECT account_id FROM email_verification_tokens WHERE token_hash = $1',
      [tokenHash],
    );
    if (ref.length === 0) {
      await client.query('ROLLBACK');
      return false;
    }
    const accountId = ref[0].account_id;
    const { rows: account } = await client.query<{ email_verified: boolean }>(
      'SELECT email_verified FROM accounts WHERE id = $1 FOR UPDATE',
      [accountId],
    );
    const { rows } = await client.query<{ id: number }>(
      `SELECT t.id
         FROM email_verification_tokens t
         JOIN accounts a ON a.id = t.account_id AND a.email = t.email
        WHERE t.token_hash = $1 AND t.account_id = $2 AND t.used_at IS NULL AND t.expires_at > now()
        FOR UPDATE OF t`,
      [tokenHash, accountId],
    );
    if (rows.length === 0 || !account[0]) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query('UPDATE email_verification_tokens SET used_at = now() WHERE id = $1', [rows[0].id]);
    if (opts.claim && !account[0].email_verified) {
      // The password stays: whoever answered 'mine' says they created the
      // account, so they set it, and they sign in with it to accept the Terms.
      // Someone who didn't set it can use Forgot password, which goes to the
      // same inbox this link did.
      await client.query(
        `UPDATE accounts
            SET email_verified = true, claimed_at = now(), pending_email = NULL,
                terms_version = NULL, terms_accepted_at = NULL,
                beta_terms_version = NULL, beta_terms_accepted_at = NULL, updated_at = now()
          WHERE id = $1`,
        [accountId],
      );
      await client.query('DELETE FROM email_change_tokens WHERE account_id = $1', [accountId]);
      await client.query('DELETE FROM pending_takeovers WHERE account_id = $1', [accountId]);
      await revokeAccountSessions(client, accountId);
    } else {
      await client.query('UPDATE accounts SET email_verified = true, updated_at = now() WHERE id = $1', [accountId]);
    }
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
