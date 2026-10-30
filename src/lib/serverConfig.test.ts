import path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ConfigError,
  getServerConfig,
  loadServerConfig,
  setServerConfigForTests,
  type ServerConfig,
} from './serverConfig';

// Config loaded by test setup; loadServerConfig/set below replace it, so put it back.
const original = getServerConfig();
afterAll(() => setServerConfigForTests(original));

const base = { STRIPE_SECRET_KEY: 'sk_test_x' };

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

  it('requires SMTP_HOST in production only', () => {
    expect(() => loadServerConfig({ ...base, NODE_ENV: 'production' })).toThrow(
      'SMTP_HOST is not set. Set it, or set MAIL_MODE=off to run without email.',
    );
    expect(() => loadServerConfig({ ...base, NODE_ENV: 'development' })).not.toThrow();
    expect(() => loadServerConfig({ ...base, NODE_ENV: 'production', SMTP_HOST: 'smtp.example.com' })).not.toThrow();
    expect(() => loadServerConfig({ ...base, NODE_ENV: 'production', MAIL_MODE: 'off' })).not.toThrow();
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
    const c = loadServerConfig({ BILLING: 'off' });
    expect(getServerConfig()).toBe(c);
  });
});

describe('setServerConfigForTests', () => {
  it('replaces the loaded config', () => {
    const custom: ServerConfig = { billing: 'off', mail: 'off', media: 'local', googleSignIn: true, weather: true };
    setServerConfigForTests(custom);
    expect(getServerConfig()).toBe(custom);
  });
});
