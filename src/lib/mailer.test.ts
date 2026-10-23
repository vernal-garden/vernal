import { describe, it, expect, vi, afterEach } from 'vitest';

const { sendMailMock } = vi.hoisted(() => ({ sendMailMock: vi.fn() }));

vi.mock('nodemailer', () => ({
  default: { createTransport: vi.fn(() => ({ sendMail: sendMailMock })) },
}));
vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// The transport is built when the module loads, so each test sets the env
// and then imports a fresh copy.
async function loadMailer() {
  vi.resetModules();
  const mailer = await import('./mailer');
  const { logger } = await import('./logger');
  return { ...mailer, logger };
}

describe('mailer', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    sendMailMock.mockReset();
    vi.restoreAllMocks();
  });

  it('refuses to load in production without SMTP_HOST', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SMTP_HOST', '');
    await expect(loadMailer()).rejects.toThrow('SMTP_HOST must be set in production');
  });

  it('logs only the recipient domain for a real send', async () => {
    vi.stubEnv('SMTP_HOST', 'smtp.example.com');
    sendMailMock.mockResolvedValueOnce({ messageId: 'm-1' });
    const { sendMail, logger } = await loadMailer();

    await sendMail({ to: 'Someone@Example.COM', subject: 's', text: 't', html: '<p>h</p>' });

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
});
