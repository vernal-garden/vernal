import { db } from './db';
import { sendMail } from './mailer';
import { generateRawToken, hashToken } from './tokens';

const VERIFY_HOURS = 24;

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

  const verifyUrl = `${process.env.FRONTEND_URL ?? 'http://localhost:5173'}/verify-email?token=${rawToken}`;
  await sendMail({
    to: email,
    subject: 'Verify your Vernal email address',
    text: `Confirm this is your email address by opening the link below. It expires in ${VERIFY_HOURS} hours.\n\n${verifyUrl}\n\nIf you didn't create a Vernal account, you can ignore this email.`,
    html: `<p>Confirm this is your email address by opening the link below. It expires in ${VERIFY_HOURS} hours.</p><p><a href="${verifyUrl}">${verifyUrl}</a></p><p>If you didn't create a Vernal account, you can ignore this email.</p>`,
  });
}

// Marks the account verified if the token is unused, unexpired, and still
// matches the account's current email. Returns false otherwise.
export async function consumeVerificationToken(rawToken: string): Promise<boolean> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: number; account_id: number }>(
      `SELECT t.id, t.account_id
         FROM email_verification_tokens t
         JOIN accounts a ON a.id = t.account_id AND a.email = t.email
        WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.expires_at > now()
        FOR UPDATE OF t`,
      [hashToken(rawToken)],
    );
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query('UPDATE email_verification_tokens SET used_at = now() WHERE id = $1', [rows[0].id]);
    await client.query('UPDATE accounts SET email_verified = true, updated_at = now() WHERE id = $1', [
      rows[0].account_id,
    ]);
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
