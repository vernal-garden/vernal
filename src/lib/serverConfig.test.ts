import path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ConfigError,
  getServerConfig,
  isLocalEnv,
  secureCookies,
  loadServerConfig,
  parseSentryDsn,
  setServerConfigForTests,
  type ServerConfig,
} from './serverConfig';

// Config loaded by test setup; loadServerConfig/set below replace it, so put it back.
const original = getServerConfig();
afterAll(() => setServerConfigForTests(original));

// development so the SMTP_HOST rule (production-strict otherwise) stays out of the way.
const base = { STRIPE_SECRET_KEY: 'sk_test_x', NODE_ENV: 'development' };
// Outside development and test the two public URLs are required.
const siteUrls = { FRONTEND_URL: 'https://app.example.com', APP_URL: 'https://app.example.com' };

describe('loadServerConfig', () => {
  it('defaults to today\'s behaviour', () => {
    expect(loadServerConfig(base)).toEqual({
      billing: 'stripe',
      mail: 'smtp',
      media: 's3',
      googleSignIn: false,
      weather: false,
      betaApplicationsCloseAt: new Date('2027-01-01T08:00:00Z'),
    });
  });

  it('turns everything off when asked', () => {
    expect(loadServerConfig({ ...siteUrls, BILLING: 'off', MAIL_MODE: 'off' })).toMatchObject({ billing: 'off', mail: 'off' });
  });

  // Linux login shells set MAIL to the mail spool path; it must not be read as the mail mode.
  it('ignores the shell MAIL variable', () => {
    expect(() => loadServerConfig({ ...base, MAIL: '/var/mail/deploy' })).not.toThrow();
    expect(loadServerConfig({ ...base, MAIL: '/var/mail/deploy' }).mail).toBe('smtp');
  });

  it('reads Google sign-in and weather from their settings', () => {
    const c = loadServerConfig({
      ...base,
      GOOGLE_CLIENT_ID: 'id',
      GOOGLE_CLIENT_SECRET: 'secret',
      VISUAL_CROSSING_API_KEY: 'key',
    });
    expect(c.googleSignIn).toBe(true);
    expect(c.weather).toBe(true);
  });

  it('treats blank values as not set', () => {
    const c = loadServerConfig({ ...base, GOOGLE_CLIENT_ID: '  ', GOOGLE_CLIENT_SECRET: '', VISUAL_CROSSING_API_KEY: ' ' });
    expect(c.googleSignIn).toBe(false);
    expect(c.weather).toBe(false);
    expect(() => loadServerConfig({ STRIPE_SECRET_KEY: '  ' })).toThrow(ConfigError);
  });

  it.each([
    ['BILLING', 'bogus', 'stripe, off'],
    ['MAIL_MODE', 'bogus', 'smtp, off'],
    ['MEDIA_STORAGE', 'bogus', 's3, local'],
  ])('rejects an invalid %s', (key, value, allowed) => {
    const run = () => loadServerConfig({ ...base, [key]: value });
    expect(run).toThrow(ConfigError);
    expect(run).toThrow(key);
    expect(run).toThrow(allowed);
  });

  it('requires STRIPE_SECRET_KEY when billing is stripe', () => {
    expect(() => loadServerConfig({})).toThrow(
      'STRIPE_SECRET_KEY is not set. Set it, or set BILLING=off to run without payments (every account then gets every feature).',
    );
  });

  describe('SMTP_HOST rule', () => {
    const smtpMessage =
      'SMTP_HOST is not set. Set it, set MAIL_MODE=off to run without email, or set NODE_ENV=development to print mail to the console on a local machine.';
    const noEnv = { STRIPE_SECRET_KEY: 'sk_test_x', ...siteUrls };

    it('is required in production', () => {
      expect(() => loadServerConfig({ ...noEnv, NODE_ENV: 'production' })).toThrow(smtpMessage);
      expect(() => loadServerConfig({ ...noEnv, NODE_ENV: 'production', SMTP_HOST: 'smtp.example.com' })).not.toThrow();
    });

    it('is required when NODE_ENV is unset', () => {
      expect(() => loadServerConfig(noEnv)).toThrow(smtpMessage);
      expect(() => loadServerConfig({ ...noEnv, SMTP_HOST: 'smtp.example.com' })).not.toThrow();
    });

    it('is optional in development', () => {
      expect(() => loadServerConfig({ ...noEnv, NODE_ENV: 'development' })).not.toThrow();
    });

    it.each([undefined, 'production', 'development'])('is not needed with MAIL_MODE=off (NODE_ENV=%s)', (nodeEnv) => {
      expect(() => loadServerConfig({ ...noEnv, NODE_ENV: nodeEnv, MAIL_MODE: 'off' })).not.toThrow();
    });
  });

  describe('NODE_ENV', () => {
    it('rejects an unknown value', () => {
      const run = () => loadServerConfig({ ...base, NODE_ENV: 'staging' });
      expect(run).toThrow(ConfigError);
      expect(run).toThrow('NODE_ENV must be one of: production, development, test (got "staging").');
    });

    it('refuses test outside the test suites', () => {
      const run = () => loadServerConfig({ ...base, NODE_ENV: 'test' });
      expect(run).toThrow(ConfigError);
      expect(run).toThrow(/NODE_ENV=test is only for the test suites and turns off rate limits/);
    });

    it('allows test under Vitest or the E2E server', () => {
      expect(() => loadServerConfig({ ...base, NODE_ENV: 'test', VITEST: 'true' })).not.toThrow();
      expect(() => loadServerConfig({ ...base, NODE_ENV: 'test', E2E_LISTEN: 'true' })).not.toThrow();
      expect(() => loadServerConfig({ ...base, NODE_ENV: 'test', E2E_LISTEN: 'false' })).toThrow(ConfigError);
    });

    it('allows production and development', () => {
      expect(() => loadServerConfig({ ...base, ...siteUrls, NODE_ENV: 'production', SMTP_HOST: 'h' })).not.toThrow();
      expect(() => loadServerConfig({ ...base, NODE_ENV: 'development' })).not.toThrow();
    });
  });

  it('requires an absolute MEDIA_DIR for local media', () => {
    expect(() => loadServerConfig({ ...base, MEDIA_STORAGE: 'local' })).toThrow(/MEDIA_DIR is not set/);
    expect(() => loadServerConfig({ ...base, MEDIA_STORAGE: 'local', MEDIA_DIR: 'relative/media' })).toThrow(
      /MEDIA_DIR must be an absolute path/,
    );
    const dir = path.resolve('media-test');
    expect(loadServerConfig({ ...base, MEDIA_STORAGE: 'local', MEDIA_DIR: dir }).media).toBe('local');
  });

  it('rejects a half-set Google pair', () => {
    expect(() => loadServerConfig({ ...base, GOOGLE_CLIENT_ID: 'id' })).toThrow(/GOOGLE_CLIENT_SECRET is not set/);
    expect(() => loadServerConfig({ ...base, GOOGLE_CLIENT_SECRET: 's' })).toThrow(/GOOGLE_CLIENT_ID is not set/);
  });

  it('rejects DATABASE_SSL=false together with DATABASE_SSL_CA', () => {
    expect(() =>
      loadServerConfig({ ...base, DATABASE_SSL: 'false', DATABASE_SSL_CA: '/etc/ssl/ca.pem' }),
    ).toThrow(ConfigError);
  });

  it('stores the result for getServerConfig', () => {
    const c = loadServerConfig({ ...siteUrls, BILLING: 'off', MAIL_MODE: 'off' });
    expect(getServerConfig()).toBe(c);
  });
});

describe('public URLs', () => {
  const prod = { STRIPE_SECRET_KEY: 'sk_test_x', NODE_ENV: 'production', SMTP_HOST: 'smtp.example.com', ...siteUrls };

  it.each(['FRONTEND_URL', 'APP_URL'])('requires %s outside development and test', (key) => {
    expect(() => loadServerConfig({ ...prod, [key]: undefined })).toThrow(`${key} is not set`);
    expect(() => loadServerConfig({ ...prod, [key]: '  ' })).toThrow(`${key} is not set`);
    expect(() => loadServerConfig({ ...prod, [key]: 'ftp://app.example.com' })).toThrow(`${key} must be an http(s) URL`);
    expect(() => loadServerConfig({ ...prod, [key]: 'not a url' })).toThrow(`${key} must be an http(s) URL`);
  });

  it('never echoes the value', () => {
    expect(() => loadServerConfig({ ...prod, APP_URL: 'secret-looking-value' })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('secret-looking-value') }),
    );
  });

  it('accepts http and https URLs', () => {
    expect(() => loadServerConfig(prod)).not.toThrow();
    expect(() => loadServerConfig({ ...prod, APP_URL: 'http://localhost:3000' })).not.toThrow();
  });

  it('counts unset NODE_ENV as production', () => {
    expect(() => loadServerConfig({ ...prod, NODE_ENV: undefined, FRONTEND_URL: undefined })).toThrow('FRONTEND_URL is not set');
  });

  it('does not require them in development', () => {
    expect(() => loadServerConfig(base)).not.toThrow();
  });
});

describe('isLocalEnv', () => {
  it('is true only for development and test', () => {
    expect(isLocalEnv({ NODE_ENV: 'development' })).toBe(true);
    expect(isLocalEnv({ NODE_ENV: 'test' })).toBe(true);
    expect(isLocalEnv({ NODE_ENV: ' development ' })).toBe(true);
  });

  it('is false for production, unset, blank and unknown values', () => {
    expect(isLocalEnv({ NODE_ENV: 'production' })).toBe(false);
    expect(isLocalEnv({})).toBe(false);
    expect(isLocalEnv({ NODE_ENV: '  ' })).toBe(false);
    expect(isLocalEnv({ NODE_ENV: 'staging' })).toBe(false);
    expect(isLocalEnv({ NODE_ENV: 'Development' })).toBe(false);
  });

  it('reads process.env by default', () => {
    expect(isLocalEnv()).toBe(true); // Vitest runs with NODE_ENV=test
  });
});

describe('secureCookies', () => {
  it('follows the FRONTEND_URL scheme', () => {
    expect(secureCookies({ FRONTEND_URL: 'https://vernal.garden' })).toBe(true);
    expect(secureCookies({ FRONTEND_URL: 'http://192.168.1.5', NODE_ENV: 'production' })).toBe(false);
    expect(secureCookies({ FRONTEND_URL: 'http://localhost:5173' })).toBe(false);
  });

  it('fails closed on an unparseable FRONTEND_URL', () => {
    expect(secureCookies({ FRONTEND_URL: 'not a url', NODE_ENV: 'development' })).toBe(true);
  });

  it('without FRONTEND_URL, secure unless NODE_ENV is development or test', () => {
    expect(secureCookies({ NODE_ENV: 'production' })).toBe(true);
    expect(secureCookies({})).toBe(true);
    expect(secureCookies({ NODE_ENV: 'development' })).toBe(false);
  });
});

describe('BETA_APPLICATIONS_CLOSE_AT', () => {
  it('defaults to 2027-01-01 Pacific, and treats blank as unset', () => {
    expect(loadServerConfig(base).betaApplicationsCloseAt.toISOString()).toBe('2027-01-01T08:00:00.000Z');
    expect(loadServerConfig({ ...base, BETA_APPLICATIONS_CLOSE_AT: '  ' }).betaApplicationsCloseAt.toISOString()).toBe(
      '2027-01-01T08:00:00.000Z',
    );
  });

  it('reads a date with an offset', () => {
    const cfg = loadServerConfig({ ...base, BETA_APPLICATIONS_CLOSE_AT: '2026-12-01T00:00:00Z' });
    expect(cfg.betaApplicationsCloseAt.toISOString()).toBe('2026-12-01T00:00:00.000Z');
  });

  it.each(['1', 'soonish 12', 'Dec 1', '2027-01-01T00:00:00', '2027-01-01', '2026-02-31T00:00:00Z'])(
    'rejects %s',
    (value) => {
      const run = () => loadServerConfig({ ...base, BETA_APPLICATIONS_CLOSE_AT: value });
      expect(run).toThrow(ConfigError);
      expect(run).toThrow('BETA_APPLICATIONS_CLOSE_AT must be an ISO 8601');
    },
  );

  it('rejects an unparseable value, naming the variable but not echoing it', () => {
    const run = () => loadServerConfig({ ...base, BETA_APPLICATIONS_CLOSE_AT: 'soonish' });
    expect(run).toThrow(ConfigError);
    expect(run).toThrow('BETA_APPLICATIONS_CLOSE_AT');
    expect(run).not.toThrow(/soonish/);
  });
});

describe('setServerConfigForTests', () => {
  it('replaces the loaded config', () => {
    const custom: ServerConfig = { billing: 'off', mail: 'off', media: 'local', googleSignIn: true, weather: true, betaApplicationsCloseAt: new Date(0) };
    setServerConfigForTests(custom);
    expect(getServerConfig()).toBe(custom);
  });
});

describe('SENTRY_CLIENT_DSN', () => {
  const dsn = 'https://abc123@o1.ingest.us.sentry.io/4511';

  it('leaves the relay off when unset or blank', () => {
    expect(loadServerConfig(base).sentryRelay).toBeUndefined();
    expect(loadServerConfig({ ...base, SENTRY_CLIENT_DSN: '  ' }).sentryRelay).toBeUndefined();
  });

  it('parses host, project id and public key', () => {
    expect(loadServerConfig({ ...base, SENTRY_CLIENT_DSN: dsn }).sentryRelay).toEqual({
      host: 'o1.ingest.us.sentry.io',
      projectId: '4511',
      publicKey: 'abc123',
    });
  });

  it.each([
    ['http scheme', 'http://abc123@o1.ingest.us.sentry.io/4511'],
    ['no public key', 'https://o1.ingest.us.sentry.io/4511'],
    ['no project id', 'https://abc123@o1.ingest.us.sentry.io/'],
    ['non-numeric project id', 'https://abc123@o1.ingest.us.sentry.io/abc'],
    ['not a URL', 'abc123-not-a-dsn'],
  ])('refuses a DSN with %s, without echoing it', (_label, value) => {
    expect(() => loadServerConfig({ ...base, SENTRY_CLIENT_DSN: value })).toThrow(ConfigError);
    try {
      loadServerConfig({ ...base, SENTRY_CLIENT_DSN: value });
    } catch (err) {
      expect((err as Error).message).toContain('SENTRY_CLIENT_DSN');
      expect((err as Error).message).not.toContain(value);
    }
  });
});

describe('parseSentryDsn', () => {
  it('accepts a trailing slash after the project id', () => {
    expect(parseSentryDsn('https://k@sentry.example.com/12/')).toEqual({
      host: 'sentry.example.com',
      projectId: '12',
      publicKey: 'k',
    });
  });

  it('returns null for anything else', () => {
    expect(parseSentryDsn('https://k@sentry.example.com/12/extra')).toBeNull();
    expect(parseSentryDsn('')).toBeNull();
  });
});
