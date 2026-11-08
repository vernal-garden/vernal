import type { PoolClient } from 'pg';
import { sendMail } from './mailer';
import { logger } from './logger';
import { generateRawToken, hashToken } from './tokens';

// Password-reset tokens and the security emails sent around account changes.
// Notices never throw: the change they report has already happened, so a
// failed send is only logged.

const appUrl = () => process.env.APP_URL ?? 'http://localhost:3000';
const frontendUrl = () => process.env.FRONTEND_URL ?? 'http://localhost:5173';

// One live reset token per account: issuing one deletes earlier unused links.
// Returns the raw token to email; only its hash is stored.
export async function issuePasswordResetToken(client: PoolClient, accountId: number): Promise<string> {
  const rawToken = generateRawToken();
  await client.query('DELETE FROM password_reset_tokens WHERE account_id = $1 AND used_at IS NULL', [accountId]);
  await client.query(
    `INSERT INTO password_reset_tokens (account_id, token_hash, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '60 minutes')`,
    [accountId, hashToken(rawToken)],
  );
  return rawToken;
}

export async function sendPasswordResetEmail(to: string, rawToken: string): Promise<void> {
  const resetUrl = `${appUrl()}/reset-password?token=${rawToken}`;
  await sendMail({
    to,
    subject: 'Reset your Vernal password',
    text: `Click this link to reset your password (expires in 1 hour):

${resetUrl}

If you didn't request this, you can ignore this email.`,
    html: `<p>Click this link to reset your password (expires in 1 hour):</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>If you didn't request this, you can ignore this email.</p>`,
  });
}

// "jane@example.com" → "j•••@example.com"
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '•••';
  return `${email[0]}•••${email.slice(at)}`;
}

// Sent to the replaced address after an email change, with a 7-day undo link.
export async function sendEmailChangedNotice(opts: {
  to: string;
  newEmail: string;
  rawToken: string;
}): Promise<void> {
  const revertUrl = `${frontendUrl()}/account/email/revert?token=${opts.rawToken}`;
  const masked = maskEmail(opts.newEmail);
  const undo =
    "If you didn't, open this link to undo it. It puts this address back, signs out every device, and lets you set a new password. It works for 7 days.";
  try {
    await sendMail({
      to: opts.to,
      subject: 'Your Vernal email address was changed',
      text: `The email address on your Vernal account was changed to ${masked}.\n\nIf you made this change, you can ignore this email.\n\n${undo}\n\n${revertUrl}`,
      html: `<p>The email address on your Vernal account was changed to ${masked}.</p><p>If you made this change, you can ignore this email.</p><p>${undo}</p><p><a href="${revertUrl}">${revertUrl}</a></p>`,
    });
  } catch (err) {
    logger.error('Email-changed notice failed to send', err);
  }
}

export async function sendPasswordChangedNotice(to: string): Promise<void> {
  const loginUrl = `${appUrl()}/login`;
  const ifNot = `If it wasn't, reset your password now: open ${loginUrl} and choose "Forgot password?".`;
  try {
    await sendMail({
      to,
      subject: 'Your Vernal password was changed',
      text: `The password on your Vernal account was just changed.\n\nIf this was you, you can ignore this email.\n\n${ifNot}`,
      html: `<p>The password on your Vernal account was just changed.</p><p>If this was you, you can ignore this email.</p><p>If it wasn't, reset your password now: open <a href="${loginUrl}">${loginUrl}</a> and choose "Forgot password?".</p>`,
    });
  } catch (err) {
    logger.error('Password-changed notice failed to send', err);
  }
}

// Sent after a Google sign-in claimed an account that had a password
// (resolveAccount.ts): the password was removed and every session revoked.
export async function sendPasswordRemovedNotice(to: string): Promise<void> {
  const loginUrl = `${frontendUrl()}/login`;
  const removed =
    'The password on your Vernal account was just removed, because you signed in with Google. Your other devices were signed out too.';
  const why =
    'This makes sure only the person who controls this email address can get into your account. Your gardens, seeds and records are all still there.';
  const ifNot =
    "If you didn't sign in with Google just now, someone else may be using your Google account. Change your Google password first, then email";
  const support = 'robert@vernal.garden';
  try {
    await sendMail({
      to,
      subject: 'Your Vernal password was removed',
      text: `${removed}\n\n${why}\n\nFrom now on, sign in with "Continue with Google". If you'd like a password as well, open ${loginUrl} and choose "Forgot password?" to set one.\n\n${ifNot} ${support}.`,
      html: `<p>${removed}</p><p>${why}</p><p>From now on, sign in with "Continue with Google". If you'd like a password as well, open <a href="${loginUrl}">${loginUrl}</a> and choose "Forgot password?" to set one.</p><p>${ifNot} <a href="mailto:${support}">${support}</a>.</p>`,
    });
  } catch (err) {
    logger.error('Password-removed notice failed to send', err);
  }
}
