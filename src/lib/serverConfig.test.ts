import path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ConfigError,
  getServerConfig,
  isLocalEnv,
  secureCookies,
  loadServerConfig,
  setServerConfigForTests,
  type ServerConfig,
} from './serverConfig';

// Config loaded by test setup; loadServerConfig/set below replace it, so put it back.
const original = getServerConfig();
afterAll(() => setServerConfigForTests(original));

// development so the SMTP_HOST rule (production-strict otherwise) stays out of the way.
const base = { STRIPE_SECRET_KEY: 'sk_test_x', NODE_ENV: 'development' };

describe('loadServerConfig', () => {
  it('defaults to today\'s behaviour', () => {
    expect(loadServerConfig(base)).toEqual({
      billing: 'stripe',
      mail: 'smtp',
      media: 's3',
      googleSignIn: false,
      weather: false,
    });
  });

  it('turns everything off when asked', () => {
    expect(loadServerConfig({ BILLING: 'off', MAIL_MODE: 'off' })).toMatchObject({ billing: 'off', mail: 'off' });
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
    const noEnv = { STRIPE_SECRET_KEY: 'sk_test_x' };

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
      expect(() => loadServerConfig({ ...base, NODE_ENV: 'production', SMTP_HOST: 'h' })).not.toThrow();
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

  it('stores the result for getServerConfig', () => {
    const c = loadServerConfig({ BILLING: 'off', MAIL_MODE: 'off' });
    expect(getServerConfig()).toBe(c);
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

describe('setServerConfigForTests', () => {
  it('replaces the loaded config', () => {
    const custom: ServerConfig = { billing: 'off', mail: 'off', media: 'local', googleSignIn: true, weather: true };
    setServerConfigForTests(custom);
    expect(getServerConfig()).toBe(custom);
  });
});
