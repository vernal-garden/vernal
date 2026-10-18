import { describe, it, expect, afterAll } from 'vitest';
import { Pool } from 'pg';
import { db, jobDb, statementTimeoutOptions } from './db';

const url = process.env.TEST_DATABASE_URL as string;

describe('statementTimeoutOptions', () => {
  it('returns a -c option for a direct Neon host', () => {
    expect(
      statementTimeoutOptions('postgresql://u:p@ep-cool-123.us-east-2.aws.neon.tech/neondb?sslmode=require', 10_000),
    ).toBe('-c statement_timeout=10000');
  });

  it('returns a -c option for a local host', () => {
    expect(statementTimeoutOptions('postgresql://postgres:postgres@localhost:5434/vernal_test', 500)).toBe(
      '-c statement_timeout=500',
    );
  });

  it('returns undefined for a Neon pooled host', () => {
    expect(
      statementTimeoutOptions('postgresql://u:p@ep-cool-123-pooler.us-east-2.aws.neon.tech/neondb', 10_000),
    ).toBeUndefined();
  });

  it('returns a -c option for an unparseable string (pg reports the real error)', () => {
    expect(statementTimeoutOptions('not a url', 10_000)).toBe('-c statement_timeout=10000');
  });
});

describe('pool statement_timeout', () => {
  const shortPool = new Pool({ connectionString: url, options: statementTimeoutOptions(url, 200) });

  afterAll(async () => {
    await shortPool.end();
  });

  it('web pool reports 10s', async () => {
    const r = await db.query('SHOW statement_timeout');
    expect(r.rows[0].statement_timeout).toBe('10s');
  });

  it('job pool reports 5min', async () => {
    const r = await jobDb.query('SHOW statement_timeout');
    expect(r.rows[0].statement_timeout).toBe('5min');
  });

  it('cancels a statement that runs past the cap', async () => {
    await expect(shortPool.query('SELECT pg_sleep(2)')).rejects.toMatchObject({ code: '57014' });
  });
});
