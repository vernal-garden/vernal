import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import {
  getBetaSettings,
  invalidateBetaSettings,
  betaAccessApplies,
  betaTermsPending,
  decideSignup,
} from './beta';
import { BETA_TERMS_VERSION } from './legal';
import { db } from './db';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL must be set to run tests');

const pool = new Pool({ connectionString: url });

async function resetBeta() {
  await pool.query('DELETE FROM beta_invites');
  await pool.query(
    `UPDATE beta_settings
        SET gate_on = false, guest_mode_on = true, supporter_access_on = true,
            gate_first_on_at = NULL
      WHERE id = 1`,
  );
  await pool.query('TRUNCATE guest_sessions CASCADE');
  invalidateBetaSettings();
}

async function setGate(on: boolean, firstOnAt: Date | null) {
  await pool.query('UPDATE beta_settings SET gate_on = $1, gate_first_on_at = $2 WHERE id = 1', [
    on,
    firstOnAt,
  ]);
  invalidateBetaSettings();
}

async function invite(email: string) {
  await pool.query('INSERT INTO beta_invites (email) VALUES ($1)', [email]);
}

async function makeGuest(opts: {
  createdAt: Date;
  expiresAt: Date;
  accountId?: number;
  migratedAt?: Date;
}): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO guest_sessions (token_hash, created_at, expires_at, account_id, migrated_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [`tok-${Math.random()}`, opts.createdAt, opts.expiresAt, opts.accountId ?? null, opts.migratedAt ?? null],
  );
  return rows[0].id;
}

async function decide(email: string, guestId: string | null) {
  const client = await pool.connect();
  try {
    return await decideSignup(client, email, guestId);
  } finally {
    client.release();
  }
}

const DAY = 86_400_000;
const switchOn = new Date(Date.now() - 10 * DAY);

beforeAll(resetBeta);
afterEach(async () => {
  vi.restoreAllMocks();
  await resetBeta();
  await pool.query('TRUNCATE accounts CASCADE');
});
afterAll(() => pool.end());

describe('pure rules', () => {
  const on = { gateOn: false, guestModeOn: true, supporterAccessOn: true, gateFirstOnAt: null };
  it('betaAccessApplies needs a participant date and the switch', () => {
    expect(betaAccessApplies(new Date(), on)).toBe(true);
    expect(betaAccessApplies(null, on)).toBe(false);
    expect(betaAccessApplies(new Date(), { ...on, supporterAccessOn: false })).toBe(false);
  });
  it('betaTermsPending is true only for a participant on an old or no version', () => {
    expect(betaTermsPending(null, null)).toBe(false);
    expect(betaTermsPending(new Date(), null)).toBe(true);
    expect(betaTermsPending(new Date(), '2020-01-01')).toBe(true);
    expect(betaTermsPending(new Date(), BETA_TERMS_VERSION)).toBe(false);
  });
});

describe('getBetaSettings cache', () => {
  it('serves the cached value until invalidated', async () => {
    expect((await getBetaSettings()).gateOn).toBe(false);
    await pool.query('UPDATE beta_settings SET gate_on = true WHERE id = 1');
    expect((await getBetaSettings()).gateOn).toBe(false);
    invalidateBetaSettings();
    expect((await getBetaSettings()).gateOn).toBe(true);
  });
});

describe('getBetaSettings failure and races', () => {
  it('does not cache a rejected read', async () => {
    vi.spyOn(db, 'query').mockRejectedValueOnce(new Error('boom'));
    await expect(getBetaSettings()).rejects.toThrow('boom');
    expect((await getBetaSettings()).gateOn).toBe(false);
  });

  it('an invalidation during an in-flight read stops the stale value being cached', async () => {
    const realQuery = db.query.bind(db) as (...a: unknown[]) => Promise<unknown>;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    // The read runs against the old row, then waits while the setting changes.
    vi.spyOn(db, 'query').mockImplementationOnce((async (...a: unknown[]) => {
      const result = await realQuery(...a);
      await gate;
      return result;
    }) as unknown as typeof db.query);
    const inFlight = getBetaSettings();
    await new Promise((r) => setTimeout(r, 50));
    await pool.query('UPDATE beta_settings SET gate_on = true WHERE id = 1');
    invalidateBetaSettings();
    release();
    expect((await inFlight).gateOn).toBe(false);
    expect((await getBetaSettings()).gateOn).toBe(true);
  });
});

describe('decideSignup', () => {
  it('gate off, invited: participant via invite', async () => {
    await invite('a@example.com');
    expect(await decide('a@example.com', null)).toEqual({ allowed: true, participant: true, via: 'invite' });
  });
  it('gate off, not invited: allowed, not a participant', async () => {
    expect(await decide('a@example.com', null)).toEqual({ allowed: true, participant: false });
  });
  it('gate on, invited: participant via invite', async () => {
    await setGate(true, switchOn);
    await invite('a@example.com');
    expect(await decide('a@example.com', null)).toEqual({ allowed: true, participant: true, via: 'invite' });
  });
  it('gate on, invited with a qualifying guest session: via invite', async () => {
    await setGate(true, switchOn);
    await invite('a@example.com');
    const id = await makeGuest({
      createdAt: new Date(switchOn.getTime() - DAY),
      expiresAt: new Date(Date.now() + DAY),
    });
    expect(await decide('a@example.com', id)).toEqual({ allowed: true, participant: true, via: 'invite' });
  });
  it('gate off, not invited, qualifying-looking guest session: not a participant', async () => {
    await setGate(false, switchOn);
    const id = await makeGuest({
      createdAt: new Date(switchOn.getTime() - DAY),
      expiresAt: new Date(Date.now() + DAY),
    });
    expect(await decide('a@example.com', id)).toEqual({ allowed: true, participant: false });
  });
  it('gate on, not invited: refused', async () => {
    await setGate(true, switchOn);
    expect(await decide('a@example.com', null)).toEqual({ allowed: false });
  });

  describe('gate on, not invited, guest session', () => {
    beforeEach(() => setGate(true, switchOn));

    it('created before and open at switch-on: allowed as participant via guest', async () => {
      const id = await makeGuest({
        createdAt: new Date(switchOn.getTime() - DAY),
        expiresAt: new Date(Date.now() + DAY),
      });
      expect(await decide('a@example.com', id)).toEqual({ allowed: true, participant: true, via: 'guest' });
    });
    it('created before but expired at switch-on: refused', async () => {
      const id = await makeGuest({
        createdAt: new Date(switchOn.getTime() - 3 * DAY),
        expiresAt: new Date(switchOn.getTime() - DAY),
      });
      expect(await decide('a@example.com', id)).toEqual({ allowed: false });
    });
    it('created after switch-on: refused', async () => {
      const id = await makeGuest({
        createdAt: new Date(switchOn.getTime() + DAY),
        expiresAt: new Date(Date.now() + DAY),
      });
      expect(await decide('a@example.com', id)).toEqual({ allowed: false });
    });
    it('an account session row: refused', async () => {
      const { rows } = await pool.query<{ id: number }>(
        `INSERT INTO accounts (email, zone, zone_location_label) VALUES ('x@example.com', '7b', 'X') RETURNING id`,
      );
      const id = await makeGuest({
        createdAt: new Date(switchOn.getTime() - DAY),
        expiresAt: new Date(Date.now() + DAY),
        accountId: rows[0].id,
      });
      expect(await decide('a@example.com', id)).toEqual({ allowed: false });
    });
    it('a migrated row: refused', async () => {
      const id = await makeGuest({
        createdAt: new Date(switchOn.getTime() - DAY),
        expiresAt: new Date(Date.now() + DAY),
        migratedAt: new Date(),
      });
      expect(await decide('a@example.com', id)).toEqual({ allowed: false });
    });
    it('gate_first_on_at null: refused', async () => {
      await setGate(true, null);
      const id = await makeGuest({
        createdAt: new Date(Date.now() - DAY),
        expiresAt: new Date(Date.now() + DAY),
      });
      expect(await decide('a@example.com', id)).toEqual({ allowed: false });
    });
  });
});
