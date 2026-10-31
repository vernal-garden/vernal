import { describe, it, expect, vi, afterEach } from 'vitest';

const { sendMailMock, createTransportMock } = vi.hoisted(() => {
  const sendMailMock = vi.fn();
  return { sendMailMock, createTransportMock: vi.fn(() => ({ sendMail: sendMailMock })) };
});

vi.mock('nodemailer', () => ({
  default: { createTransport: createTransportMock },
}));
vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const message = { to: 'Someone@Example.COM', subject: 'Secret subject', text: 'secret body', html: '<p>h</p>' };

// The transport is built on first send and the config is module state, so
// each test sets the env and then imports a fresh copy.
async function loadMailer(mail: 'smtp' | 'off' = 'smtp') {
  vi.resetModules();
  const serverConfig = await import('./serverConfig');
  serverConfig.setServerConfigForTests({
    billing: 'off',
    mail,
    media: 's3',
    googleSignIn: false,
    weather: false,
  });
  const mailer = await import('./mailer');
  const { logger } = await import('./logger');
  return { ...mailer, logger };
}

describe('mailer', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    sendMailMock.mockReset();
    createTransportMock.mockClear();
    vi.restoreAllMocks();
  });

  it('does not build a transport when the module loads', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SMTP_HOST', '');
    await expect(loadMailer()).resolves.toBeDefined();
    expect(createTransportMock).not.toHaveBeenCalled();
  });

  it('refuses to send in production without SMTP_HOST', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SMTP_HOST', '');
    const { sendMail } = await loadMailer();
    await expect(sendMail(message)).rejects.toThrow('SMTP_HOST must be set');
  });

  it('refuses to fall back to the console when NODE_ENV is unset', async () => {
    vi.stubEnv('NODE_ENV', undefined);
    vi.stubEnv('SMTP_HOST', '');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { sendMail } = await loadMailer();
    await expect(sendMail(message)).rejects.toThrow('SMTP_HOST must be set');
    expect(log).not.toHaveBeenCalled();
  });

  it('logs only the recipient domain for a real send', async () => {
    vi.stubEnv('SMTP_HOST', 'smtp.example.com');
    sendMailMock.mockResolvedValueOnce({ messageId: 'm-1' });
    const { sendMail, logger } = await loadMailer();

    await sendMail(message);

    expect(logger.info).toHaveBeenCalledWith('Email sent', { recipientDomain: 'example.com', messageId: 'm-1' });
    expect(JSON.stringify(vi.mocked(logger.info).mock.calls)).not.toContain('Someone');
  });

  it('still prints the full message in dev mode', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('SMTP_HOST', '');
    sendMailMock.mockResolvedValueOnce({ messageId: 'm-2' });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { sendMail } = await loadMailer();

    await sendMail({ to: 'dev@example.com', subject: 'Reset', text: 'link: http://x/reset', html: '' });

    const printed = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('dev@example.com');
    expect(printed).toContain('link: http://x/reset');
  });

  describe('with mail off', () => {
    it('sends nothing and logs one line with no address, subject or body', async () => {
      vi.stubEnv('SMTP_HOST', 'smtp.example.com');
      const { sendMail, logger } = await loadMailer('off');

      await expect(sendMail(message)).resolves.toBeUndefined();

      expect(createTransportMock).not.toHaveBeenCalled();
      expect(sendMailMock).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledTimes(1);
      expect(vi.mocked(logger.info).mock.calls[0]).toEqual(['mail off: message skipped']);
    });

    it('does not print the dev message to the console', async () => {
      vi.stubEnv('NODE_ENV', 'development');
      vi.stubEnv('SMTP_HOST', '');
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const { sendMail } = await loadMailer('off');

      await sendMail(message);

      expect(log).not.toHaveBeenCalled();
    });

    it('isMailEnabled follows the config', async () => {
      expect((await loadMailer('off')).isMailEnabled()).toBe(false);
      expect((await loadMailer('smtp')).isMailEnabled()).toBe(true);
    });
  });
});
