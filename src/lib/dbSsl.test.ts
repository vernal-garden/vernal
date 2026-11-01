import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { dbConnectionString, dbSslConfig, dbSslMode } from './dbSsl';
import { ConfigError } from './configError';

let dir: string;
let caFile: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbssl-'));
  caFile = path.join(dir, 'ca.pem');
  fs.writeFileSync(caFile, '-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n');
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const prod = { NODE_ENV: 'production' };

describe('dbSslConfig', () => {
  it('verifies against the built-in CAs by default', () => {
    expect(dbSslConfig(prod)).toEqual({ rejectUnauthorized: true });
    expect(dbSslConfig({})).toEqual({ rejectUnauthorized: true });
  });

  it('is off under NODE_ENV=test', () => {
    expect(dbSslConfig({ NODE_ENV: 'test' })).toBe(false);
  });

  it('is off with DATABASE_SSL=false', () => {
    expect(dbSslConfig({ ...prod, DATABASE_SSL: 'false' })).toBe(false);
  });

  it('keeps TLS on for any other DATABASE_SSL value', () => {
    for (const v of ['False', '0', 'off', 'true', '']) {
      expect(dbSslConfig({ ...prod, DATABASE_SSL: v })).toEqual({ rejectUnauthorized: true });
    }
  });

  it('uses DATABASE_SSL_CA when set', () => {
    expect(dbSslConfig({ ...prod, DATABASE_SSL_CA: caFile })).toEqual({
      rejectUnauthorized: true,
      ca: fs.readFileSync(caFile, 'utf8'),
    });
  });

  it('treats a blank DATABASE_SSL_CA as unset', () => {
    expect(dbSslConfig({ ...prod, DATABASE_SSL_CA: '   ' })).toEqual({ rejectUnauthorized: true });
  });

  it('refuses DATABASE_SSL=false together with DATABASE_SSL_CA', () => {
    expect(() => dbSslConfig({ ...prod, DATABASE_SSL: 'false', DATABASE_SSL_CA: caFile })).toThrow(ConfigError);
  });

  it('refuses a relative DATABASE_SSL_CA', () => {
    expect(() => dbSslConfig({ ...prod, DATABASE_SSL_CA: 'ca.pem' })).toThrow(/DATABASE_SSL_CA must be an absolute path/);
  });

  it('refuses a missing DATABASE_SSL_CA file', () => {
    const missing = path.join(dir, 'nope.pem');
    expect(() => dbSslConfig({ ...prod, DATABASE_SSL_CA: missing })).toThrow(ConfigError);
    expect(() => dbSslConfig({ ...prod, DATABASE_SSL_CA: missing })).toThrow(missing);
  });
});

describe('dbSslConfig with a directory CA', () => {
  it('refuses DATABASE_SSL_CA pointing at a directory', () => {
    expect(() => dbSslConfig({ ...prod, DATABASE_SSL_CA: dir })).toThrow(ConfigError);
  });
});

describe('dbConnectionString', () => {
  let warn: MockInstance;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it('strips each TLS parameter', () => {
    for (const p of ['ssl', 'sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'uselibpqcompat']) {
      const out = dbConnectionString(`postgres://u:p@h/db?${p}=x`);
      expect(new URL(out).searchParams.has(p)).toBe(false);
    }
  });

  it('keeps other parameters and the rest of the URL', () => {
    const out = new URL(
      dbConnectionString('postgres://u:p@h:5432/db?application_name=vernal&sslmode=require&options=-c%20x%3D1'),
    );
    expect(out.username).toBe('u');
    expect(out.password).toBe('p');
    expect(out.host).toBe('h:5432');
    expect(out.pathname).toBe('/db');
    expect(out.searchParams.get('application_name')).toBe('vernal');
    expect(out.searchParams.get('options')).toBe('-c x=1');
    expect(out.searchParams.has('sslmode')).toBe(false);
  });

  it('returns the same string and stays quiet when no TLS parameter is present', () => {
    const url = 'postgres://u:p@h/db?application_name=vernal';
    expect(dbConnectionString(url)).toBe(url);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns with the parameter names but never the URL', () => {
    dbConnectionString('postgres://user:s3cret@db.example.com/db?sslmode=require&sslrootcert=/x.pem');
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain('sslmode');
    expect(message).toContain('sslrootcert');
    expect(message).not.toContain('s3cret');
    expect(message).not.toContain('db.example.com');
  });

  it('returns a malformed string as-is', () => {
    expect(dbConnectionString('not a url')).toBe('not a url');
  });

  it('lets our ssl option reach pg despite sslmode in the URL', () => {
    const ConnectionParameters = require('pg/lib/connection-parameters'); // eslint-disable-line @typescript-eslint/no-require-imports
    const params = new ConnectionParameters({
      connectionString: dbConnectionString('postgres://u:p@h/db?sslmode=require'),
      ssl: { rejectUnauthorized: true, ca: 'CA' },
    });
    expect(params.ssl).toEqual({ rejectUnauthorized: true, ca: 'CA' });
  });
});

describe('dbSslMode', () => {
  it('names each mode', () => {
    expect(dbSslMode(prod)).toBe('verified');
    expect(dbSslMode({ ...prod, DATABASE_SSL_CA: caFile })).toBe('verified (custom CA)');
    expect(dbSslMode({ ...prod, DATABASE_SSL: 'false' })).toBe('off');
    expect(dbSslMode({ NODE_ENV: 'test' })).toBe('off');
  });
});
