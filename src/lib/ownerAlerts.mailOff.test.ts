import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The real mailer runs here; only its mail switch and nodemailer are replaced.
const { createTransportMock, transportSendMailMock } = vi.hoisted(() => ({
  createTransportMock: vi.fn(),
  transportSendMailMock: vi.fn(),
}));

vi.mock('nodemailer', () => {
  createTransportMock.mockImplementation(() => ({ sendMail: transportSendMailMock }));
  return { default: { createTransport: createTransportMock } };
});

vi.mock('./serverConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./serverConfig')>()),
  isMailEnabled: () => false,
}));

import { sendOwnerAlert } from './ownerAlerts';

const originalTo = process.env.ALERT_EMAIL_TO;

beforeEach(() => {
  process.env.ALERT_EMAIL_TO = 'alerts@example.test';
  createTransportMock.mockClear();
  transportSendMailMock.mockClear();
});

afterEach(() => {
  if (originalTo === undefined) delete process.env.ALERT_EMAIL_TO;
  else process.env.ALERT_EMAIL_TO = originalTo;
});

describe('sendOwnerAlert with mail off', () => {
  it('resolves without creating or using a transport', async () => {
    await expect(
      sendOwnerAlert({ kind: 'test_kind', subject: 'Hello', lines: ['One.'] }),
    ).resolves.toBeUndefined();
    expect(createTransportMock).not.toHaveBeenCalled();
    expect(transportSendMailMock).not.toHaveBeenCalled();
  });
});
