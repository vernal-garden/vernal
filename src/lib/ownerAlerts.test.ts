import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import * as mailer from './mailer';
import { logger } from './logger';
import { db } from './db';
import { formatUsd, pacificParts, recordOwnerEvent, sendOwnerAlert } from './ownerAlerts';

vi.mock('./mailer', () => ({ sendMail: vi.fn().mockResolvedValue(undefined) }));
const sendMailMock = vi.mocked(mailer.sendMail);

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL must be set to run tests');
const pool = new Pool({ connectionString: url });

const ENV_KEYS = ['ALERT_EMAIL_TO', 'FEEDBACK_NOTIFY_EMAIL', 'FRONTEND_URL'] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

beforeAll(() => pool.query('TRUNCATE owner_events RESTART IDENTITY'));
afterAll(async () => {
  await pool.query('TRUNCATE owner_events RESTART IDENTITY');
  await pool.end();
  await db.end();
});

beforeEach(() => {
  sendMailMock.mockReset();
  sendMailMock.mockResolvedValue(undefined);
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
});

const alert = { kind: 'test_kind', subject: 'Hello', lines: ['One.', 'Two.'] };

describe('sendOwnerAlert recipient', () => {
  it('prefers ALERT_EMAIL_TO over FEEDBACK_NOTIFY_EMAIL', async () => {
    process.env.ALERT_EMAIL_TO = ' alerts@example.test ';
    process.env.FEEDBACK_NOTIFY_EMAIL = 'feedback@example.test';
    await sendOwnerAlert(alert);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(sendMailMock.mock.calls[0][0].to).toBe('alerts@example.test');
  });

  it('falls back to FEEDBACK_NOTIFY_EMAIL when ALERT_EMAIL_TO is empty', async () => {
    process.env.ALERT_EMAIL_TO = '   ';
    process.env.FEEDBACK_NOTIFY_EMAIL = 'feedback@example.test';
    await sendOwnerAlert(alert);
    expect(sendMailMock.mock.calls[0][0].to).toBe('feedback@example.test');
  });

  it('sends nothing when neither is set', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    await sendOwnerAlert(alert);
    expect(sendMailMock).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('sendOwnerAlert content', () => {
  beforeEach(() => {
    process.env.ALERT_EMAIL_TO = 'alerts@example.test';
  });

  it('prefixes the subject and strips CR, LF and NUL', async () => {
    await sendOwnerAlert({ ...alert, subject: 'Bad\r\nBcc: x\0y' });
    expect(sendMailMock.mock.calls[0][0].subject).toBe('[Vernal app] BadBcc: xy');
  });

  it('joins lines with blank lines in the text body', async () => {
    await sendOwnerAlert(alert);
    expect(sendMailMock.mock.calls[0][0].text).toBe('One.\n\nTwo.');
  });

  it('escapes HTML in lines and the link label', async () => {
    await sendOwnerAlert({
      ...alert,
      lines: ['<script>alert("x")</script> & \'q\''],
      link: { label: '<b>Open</b>', path: '/admin/users' },
    });
    const { html } = sendMailMock.mock.calls[0][0];
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>');
    expect(html).toContain('<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39;</p>');
  });

  it('builds the link from FRONTEND_URL in text and html', async () => {
    process.env.FRONTEND_URL = 'https://app.example.test';
    await sendOwnerAlert({ ...alert, link: { label: 'Open users', path: '/admin/users' } });
    const mail = sendMailMock.mock.calls[0][0];
    expect(mail.text).toBe('One.\n\nTwo.\n\nOpen users: https://app.example.test/admin/users');
    expect(mail.html).toContain('<p><a href="https://app.example.test/admin/users">Open users</a></p>');
  });

  it('escapes special characters in the link URL attribute', async () => {
    process.env.FRONTEND_URL = 'https://app.example.test';
    await sendOwnerAlert({ ...alert, link: { label: 'Open', path: '/admin/users?a=1&b="x"' } });
    expect(sendMailMock.mock.calls[0][0].html).toContain(
      '<a href="https://app.example.test/admin/users?a=1&amp;b=&quot;x&quot;">Open</a>',
    );
  });

  it('renders a line with its own link in text and html, escaped', async () => {
    process.env.FRONTEND_URL = 'https://app.example.test';
    await sendOwnerAlert({
      ...alert,
      lines: ['Plain.', { text: 'A & B.', link: { label: 'Open <x>', path: '/admin/beta' } }],
    });
    const mail = sendMailMock.mock.calls[0][0];
    expect(mail.text).toBe('Plain.\n\nA & B. — https://app.example.test/admin/beta');
    expect(mail.html).toContain('<p>Plain.</p>');
    expect(mail.html).toContain('<p>A &amp; B. <a href="https://app.example.test/admin/beta">Open &lt;x&gt;</a></p>');
  });

  it('falls back to the local client URL when FRONTEND_URL is unset', async () => {
    await sendOwnerAlert({ ...alert, link: { label: 'Open users', path: '/admin/users' } });
    expect(sendMailMock.mock.calls[0][0].text).toContain('Open users: http://localhost:5173/admin/users');
  });
});

describe('sendOwnerAlert failure', () => {
  it('resolves and warns once with only kind and errCode', async () => {
    process.env.ALERT_EMAIL_TO = 'alerts@example.test';
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const err = Object.assign(new Error('SMTP down for alerts@example.test'), { code: 'ECONNECTION' });
    sendMailMock.mockRejectedValue(err);

    await expect(sendOwnerAlert({ ...alert, kind: 'new_account' })).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('Owner alert failed', { kind: 'new_account', errCode: 'ECONNECTION' });
  });

  it('uses the error name when there is no code', async () => {
    process.env.ALERT_EMAIL_TO = 'alerts@example.test';
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    sendMailMock.mockRejectedValue(new TypeError('boom'));
    await sendOwnerAlert(alert);
    expect(warn).toHaveBeenCalledWith('Owner alert failed', { kind: 'test_kind', errCode: 'TypeError' });
  });
});

describe('pacificParts', () => {
  it('handles the 2026-11-01 DST change', () => {
    expect(pacificParts(new Date('2026-11-01T07:30:00Z'))).toEqual({ date: '2026-11-01', hour: 0 });
    expect(pacificParts(new Date('2026-11-01T08:30:00Z'))).toEqual({ date: '2026-11-01', hour: 1 }); // PDT
    expect(pacificParts(new Date('2026-11-01T09:30:00Z'))).toEqual({ date: '2026-11-01', hour: 1 }); // PST
    expect(pacificParts(new Date('2026-11-01T10:30:00Z'))).toEqual({ date: '2026-11-01', hour: 2 });
  });

  it('returns the Pacific date when it differs from the UTC date', () => {
    expect(pacificParts(new Date('2026-11-12T03:15:00Z'))).toEqual({ date: '2026-11-11', hour: 19 });
  });

  it('handles the 2026-03-08 spring-forward change', () => {
    expect(pacificParts(new Date('2026-03-08T09:30:00Z'))).toEqual({ date: '2026-03-08', hour: 1 });
    expect(pacificParts(new Date('2026-03-08T10:30:00Z'))).toEqual({ date: '2026-03-08', hour: 3 });
  });
});

describe('formatUsd', () => {
  it('formats usd with a dollar sign, case-insensitively', () => {
    expect(formatUsd(500, 'usd')).toBe('$5.00');
    expect(formatUsd(1999, 'USD')).toBe('$19.99');
  });

  it('formats other currencies with the uppercase code', () => {
    expect(formatUsd(500, 'eur')).toBe('5.00 EUR');
  });
});

describe('recordOwnerEvent', () => {
  it('inserts a row through the default pool', async () => {
    await pool.query('TRUNCATE owner_events RESTART IDENTITY');
    await recordOwnerEvent('account_created');
    const { rows } = await pool.query('SELECT kind, occurred_at FROM owner_events');
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('account_created');
    expect(rows[0].occurred_at).toBeInstanceOf(Date);
  });

  it('inserts through a given client and follows its transaction', async () => {
    await pool.query('TRUNCATE owner_events RESTART IDENTITY');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await recordOwnerEvent('refund', client);
      await client.query('ROLLBACK');
      expect((await pool.query('SELECT 1 FROM owner_events')).rowCount).toBe(0);

      await client.query('BEGIN');
      await recordOwnerEvent('dispute', client);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const { rows } = await pool.query('SELECT kind FROM owner_events');
    expect(rows.map((r) => r.kind)).toEqual(['dispute']);
  });
});
