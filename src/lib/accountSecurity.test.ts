import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as mailer from './mailer';
import { logger } from './logger';
import { maskEmail, sendPasswordRemovedNotice } from './accountSecurity';

vi.mock('./mailer', () => ({ sendMail: vi.fn().mockResolvedValue(undefined) }));
const sendMailMock = vi.mocked(mailer.sendMail);

describe('maskEmail', () => {
  it('keeps the first character and the domain', () => {
    expect(maskEmail('jane@example.com')).toBe('j•••@example.com');
  });

  it('handles a one-character local part', () => {
    expect(maskEmail('j@example.com')).toBe('j•••@example.com');
  });

  it('fully masks a string with no usable @', () => {
    expect(maskEmail('@example.com')).toBe('•••');
    expect(maskEmail('nope')).toBe('•••');
  });
});

describe('sendPasswordRemovedNotice', () => {
  beforeEach(() => {
    sendMailMock.mockClear();
    vi.stubEnv('FRONTEND_URL', 'https://app.vernal.test');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('sends the approved text and html to the address', async () => {
    await sendPasswordRemovedNotice('owner@example.com');
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const mail = sendMailMock.mock.calls[0][0];
    expect(mail.to).toBe('owner@example.com');
    expect(mail.subject).toBe('Your Vernal password was removed');
    expect(mail.text).toBe(
      'The password on your Vernal account was just removed, because you signed in with Google. Your other devices were signed out too.\n\n' +
        'This makes sure only the person who controls this email address can get into your account. Your gardens, seeds and records are all still there.\n\n' +
        `From now on, sign in with "Continue with Google". If you'd like a password as well, open https://app.vernal.test/login and choose "Forgot password?" to set one.\n\n` +
        "If you didn't sign in with Google just now, someone else may be using your Google account. Change your Google password first, then email robert@vernal.garden.",
    );
    expect(mail.html).toBe(
      '<p>The password on your Vernal account was just removed, because you signed in with Google. Your other devices were signed out too.</p>' +
        '<p>This makes sure only the person who controls this email address can get into your account. Your gardens, seeds and records are all still there.</p>' +
        `<p>From now on, sign in with "Continue with Google". If you'd like a password as well, open <a href="https://app.vernal.test/login">https://app.vernal.test/login</a> and choose "Forgot password?" to set one.</p>` +
        `<p>If you didn't sign in with Google just now, someone else may be using your Google account. Change your Google password first, then email <a href="mailto:robert@vernal.garden">robert@vernal.garden</a>.</p>`,
    );
  });

  it('logs a failed send instead of throwing', async () => {
    sendMailMock.mockRejectedValueOnce(new Error('SMTP down'));
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    try {
      await expect(sendPasswordRemovedNotice('owner@example.com')).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalledWith('Password-removed notice failed to send', expect.any(Error));
    } finally {
      errorSpy.mockRestore();
    }
  });
});
