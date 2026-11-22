import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import { runSowingReminders } from './sowingReminders';
import { getServerConfig, setServerConfigForTests } from './serverConfig';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL must be set to run tests');

const pool = new Pool({ connectionString: url });

// Windows below are derived from the owner's last spring frost (computeWindows):
// with frost 04-15, a tomato (6 weeks to transplant, tender) starts indoors
// 02-25..03-11 and transplants 04-22..05-06; a hardy direct-sow seed sows
// 03-04..04-01.
const SEASON = 2027;
const FROST = '2027-04-15';

// Noon Pacific on the given calendar date, so it can't straddle a day.
function at(date: string): Date {
  return new Date(`${date}T20:00:00Z`);
}

async function resetDb() {
  await pool.query(
    `TRUNCATE accounts, guest_sessions, gardens, beds, plantings, seeds, notifications,
       user_seed_preferences, sowing_reminders_sent RESTART IDENTITY CASCADE`,
  );
  await pool.query('TRUNCATE cambium.seeds RESTART IDENTITY CASCADE');
}

// Reminders are off unless SOWING_REMINDERS_ENABLED is set; these tests run
// with them on except where a test turns them off.
const originalConfig = getServerConfig();
beforeEach(async () => {
  setServerConfigForTests({ ...originalConfig, sowingReminders: true });
  await resetDb();
});
afterAll(async () => {
  setServerConfigForTests(originalConfig);
  await pool.end();
});

let emailCounter = 0;

async function createAccount(lastFrost: string | null = FROST): Promise<number> {
  emailCounter += 1;
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO accounts (email, zone, zone_location_label, last_spring_frost_date)
     VALUES ($1, '7b', 'Test City', $2::date) RETURNING id`,
    [`sowing-reminders-${emailCounter}@example.com`, lastFrost],
  );
  return rows[0].id;
}

async function createGarden(ownerId: number | null, guestSessionId: string | null = null) {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO gardens (owner_id, guest_session_id, name, style, zone)
     VALUES ($1, $2, 'Reminder Garden', 'grid', '7b') RETURNING id`,
    [ownerId, guestSessionId],
  );
  return rows[0].id;
}

async function createBed(gardenId: number, season = SEASON): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO beds (garden_id, season, type, grid_x, grid_y, grid_cols, grid_rows)
     VALUES ($1, $2, 'grid', 0, 0, 6, 6) RETURNING id`,
    [gardenId, season],
  );
  return rows[0].id;
}

async function createCambiumSeed(
  name: string,
  weeksToTransplant: number | null,
  frostTolerance: string,
): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO cambium.seeds (common_name, source, weeks_to_transplant, frost_tolerance)
     VALUES ($1, 'editorial', $2, $3) RETURNING id`,
    [name, weeksToTransplant, frostTolerance],
  );
  return rows[0].id;
}

async function createPersonalSeed(
  ownerId: number,
  name: string,
  weeksToTransplant: number | null,
  frostTolerance: string,
): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO seeds
       (owner_id, common_name, origin, contribution_status, weeks_to_transplant, frost_tolerance)
     VALUES ($1, $2, 'user_created', 'private', $3, $4) RETURNING id`,
    [ownerId, name, weeksToTransplant, frostTolerance],
  );
  return rows[0].id;
}

async function createPlanting(
  bedId: number,
  gardenId: number,
  opts: {
    seedId?: number;
    cambiumSeedId?: number;
    season?: number;
    state?: 'planned' | 'growing';
    plantingDate?: string | null;
    startMethod?: 'sown' | 'transplanted';
  },
): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO plantings
       (bed_id, garden_id, season, seed_id, cambium_seed_id, planting_date, start_method, state,
        cell_x, cell_y)
     VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8,
             (SELECT COUNT(*)::int FROM plantings WHERE bed_id = $1), 0)
     RETURNING id`,
    [
      bedId,
      gardenId,
      opts.season ?? SEASON,
      opts.seedId ?? null,
      opts.cambiumSeedId ?? null,
      opts.plantingDate ?? null,
      opts.startMethod ?? 'sown',
      opts.state ?? 'planned',
    ],
  );
  return rows[0].id;
}

async function notifications() {
  const { rows } = await pool.query<{ account_id: number; type: string; payload: unknown }>(
    'SELECT account_id, type, payload FROM notifications ORDER BY id',
  );
  return rows;
}

async function setup() {
  const ownerId = await createAccount();
  const gardenId = await createGarden(ownerId);
  const bedId = await createBed(gardenId);
  return { ownerId, gardenId, bedId };
}

describe('runSowingReminders', () => {
  it('does nothing while SOWING_REMINDERS_ENABLED is off', async () => {
    setServerConfigForTests({ ...originalConfig, sowingReminders: false });
    const { gardenId, bedId } = await setup();
    const tomato = await createCambiumSeed('Tomato', 6, 'none');
    await createPlanting(bedId, gardenId, { cambiumSeedId: tomato });

    expect(await runSowingReminders(at('2027-02-24'))).toEqual({ affected: 0, failed: 0 });
    expect(await notifications()).toEqual([]);
    const { rows } = await pool.query('SELECT 1 FROM sowing_reminders_sent');
    expect(rows).toEqual([]);
  });

  it('skips an account scheduled for deletion', async () => {
    const { ownerId, gardenId, bedId } = await setup();
    const tomato = await createCambiumSeed('Tomato', 6, 'none');
    await createPlanting(bedId, gardenId, { cambiumSeedId: tomato });
    await pool.query('UPDATE accounts SET deletion_scheduled_at = NOW() WHERE id = $1', [ownerId]);

    expect(await runSowingReminders(at('2027-02-24'))).toEqual({ affected: 0, failed: 0 });
    expect(await notifications()).toEqual([]);
    const { rows } = await pool.query('SELECT 1 FROM sowing_reminders_sent');
    expect(rows).toEqual([]);
  });

  it('reminds a planned tomato when its indoor-start window opens', async () => {
    const { ownerId, gardenId, bedId } = await setup();
    const tomato = await createCambiumSeed('Tomato', 6, 'none');
    await createPlanting(bedId, gardenId, { cambiumSeedId: tomato });

    // Window opens 02-25; nothing the day before tomorrow reaches it.
    expect(await runSowingReminders(at('2027-02-23'))).toEqual({ affected: 0, failed: 0 });
    expect(await notifications()).toEqual([]);

    expect(await runSowingReminders(at('2027-02-24'))).toEqual({ affected: 1, failed: 0 });
    expect(await notifications()).toEqual([
      {
        account_id: ownerId,
        type: 'sowing_reminder',
        payload: {
          gardenId,
          gardenName: 'Reminder Garden',
          season: SEASON,
          open: { indoor_start: ['Tomato'] },
        },
      },
    ]);
    const { rows } = await pool.query(
      'SELECT garden_id, seed_key, season, window_kind, reminder FROM sowing_reminders_sent',
    );
    expect(rows).toEqual([
      { garden_id: gardenId, seed_key: `cambium:${tomato}`, season: SEASON, window_kind: 'indoor_start', reminder: 'open' },
    ]);
  });

  it('gives a growing tomato sown before the transplant window the transplant_sown reminder', async () => {
    const { gardenId, bedId } = await setup();
    const tomato = await createCambiumSeed('Tomato', 6, 'none');
    await createPlanting(bedId, gardenId, {
      cambiumSeedId: tomato,
      state: 'growing',
      plantingDate: '2027-03-01',
    });

    expect(await runSowingReminders(at('2027-04-25'))).toEqual({ affected: 1, failed: 0 });
    const [n] = await notifications();
    expect(n.payload).toEqual({
      gardenId,
      gardenName: 'Reminder Garden',
      season: SEASON,
      open: { transplant_sown: ['Tomato'] },
    });
  });

  it('does not remind a growing tomato sown once the transplant window opened', async () => {
    const { gardenId, bedId } = await setup();
    const tomato = await createCambiumSeed('Tomato', 6, 'none');
    await createPlanting(bedId, gardenId, {
      cambiumSeedId: tomato,
      state: 'growing',
      plantingDate: '2027-04-22', // the window's first day
    });

    expect(await runSowingReminders(at('2027-04-25'))).toEqual({ affected: 0, failed: 0 });
    expect(await notifications()).toEqual([]);
  });

  it('does not give the transplant reminder to a growing tomato that was transplanted', async () => {
    const { gardenId, bedId } = await setup();
    const tomato = await createCambiumSeed('Tomato', 6, 'none');
    await createPlanting(bedId, gardenId, {
      cambiumSeedId: tomato,
      state: 'growing',
      plantingDate: '2027-03-01',
      startMethod: 'transplanted',
    });

    expect(await runSowingReminders(at('2027-04-25'))).toEqual({ affected: 0, failed: 0 });
  });

  it('puts a planned tomato in transplant, not transplant_sown', async () => {
    const { gardenId, bedId } = await setup();
    const tomato = await createCambiumSeed('Tomato', 6, 'none');
    await createPlanting(bedId, gardenId, { cambiumSeedId: tomato });
    await createPlanting(bedId, gardenId, {
      cambiumSeedId: tomato,
      state: 'growing',
      plantingDate: '2027-03-01',
    });

    await runSowingReminders(at('2027-04-25'));
    const [n] = await notifications();
    expect(n.payload).toEqual({
      gardenId,
      gardenName: 'Reminder Garden',
      season: SEASON,
      open: { transplant: ['Tomato'] },
    });
  });

  it('reminds a direct-sow seed when its window opens', async () => {
    const { ownerId, gardenId, bedId } = await setup();
    const peas = await createPersonalSeed(ownerId, 'Peas', null, 'hard');
    await createPlanting(bedId, gardenId, { seedId: peas });

    expect(await runSowingReminders(at('2027-03-02'))).toEqual({ affected: 0, failed: 0 });
    expect(await runSowingReminders(at('2027-03-03'))).toEqual({ affected: 1, failed: 0 });
    const [n] = await notifications();
    expect(n.payload).toEqual({
      gardenId,
      gardenName: 'Reminder Garden',
      season: SEASON,
      open: { direct_sow: ['Peas'] },
    });
    const { rows } = await pool.query('SELECT seed_key, window_kind FROM sowing_reminders_sent');
    expect(rows).toEqual([{ seed_key: `seed:${peas}`, window_kind: 'direct_sow' }]);
  });

  it('sends the closing reminder 7 days before the window ends', async () => {
    const { gardenId, bedId } = await setup();
    const tomato = await createCambiumSeed('Tomato', 6, 'none');
    await createPlanting(bedId, gardenId, { cambiumSeedId: tomato });

    await runSowingReminders(at('2027-03-01')); // open
    // Indoor window ends 03-11; the closing threshold 03-04 is not yet tomorrow.
    expect(await runSowingReminders(at('2027-03-02'))).toEqual({ affected: 0, failed: 0 });
    expect(await runSowingReminders(at('2027-03-03'))).toEqual({ affected: 1, failed: 0 });

    const all = await notifications();
    expect(all).toHaveLength(2);
    expect(all[1].payload).toEqual({
      gardenId,
      gardenName: 'Reminder Garden',
      season: SEASON,
      closing: [{ name: 'Tomato', windowKind: 'indoor_start', endsOn: '2027-03-11' }],
    });
  });

  it('sends open and closing together when a planned planting arrives late in the window', async () => {
    const { gardenId, bedId } = await setup();
    const tomato = await createCambiumSeed('Tomato', 6, 'none');
    await createPlanting(bedId, gardenId, { cambiumSeedId: tomato });

    expect(await runSowingReminders(at('2027-03-05'))).toEqual({ affected: 1, failed: 0 });
    const [n] = await notifications();
    expect(n.payload).toEqual({
      gardenId,
      gardenName: 'Reminder Garden',
      season: SEASON,
      open: { indoor_start: ['Tomato'] },
      closing: [{ name: 'Tomato', windowKind: 'indoor_start', endsOn: '2027-03-11' }],
    });
  });

  it('sends no closing reminder once the planting is no longer planned', async () => {
    const { gardenId, bedId } = await setup();
    const tomato = await createCambiumSeed('Tomato', 6, 'none');
    const plantingId = await createPlanting(bedId, gardenId, { cambiumSeedId: tomato });

    await runSowingReminders(at('2027-03-01'));
    await pool.query(
      `UPDATE plantings SET state = 'growing', planting_date = '2027-03-02' WHERE id = $1`,
      [plantingId],
    );

    expect(await runSowingReminders(at('2027-03-05'))).toEqual({ affected: 0, failed: 0 });
    expect(await notifications()).toHaveLength(1);
  });

  it('sends nothing new on a second run', async () => {
    const { gardenId, bedId } = await setup();
    const tomato = await createCambiumSeed('Tomato', 6, 'none');
    await createPlanting(bedId, gardenId, { cambiumSeedId: tomato });

    expect(await runSowingReminders(at('2027-03-05'))).toEqual({ affected: 1, failed: 0 });
    expect(await runSowingReminders(at('2027-03-05'))).toEqual({ affected: 0, failed: 0 });
    expect(await notifications()).toHaveLength(1);
  });

  it('sends one notification for two seeds in one garden', async () => {
    const { gardenId, bedId } = await setup();
    const tomato = await createCambiumSeed('Tomato', 6, 'none');
    const pepper = await createCambiumSeed('Pepper', 6, 'warm');
    await createPlanting(bedId, gardenId, { cambiumSeedId: tomato });
    await createPlanting(bedId, gardenId, { cambiumSeedId: tomato });
    await createPlanting(bedId, gardenId, { cambiumSeedId: pepper });

    expect(await runSowingReminders(at('2027-03-01'))).toEqual({ affected: 1, failed: 0 });
    const all = await notifications();
    expect(all).toHaveLength(1);
    expect(all[0].payload).toEqual({
      gardenId,
      gardenName: 'Reminder Garden',
      season: SEASON,
      open: { indoor_start: ['Pepper', 'Tomato'] },
    });
  });

  it('sends nothing for a guest garden', async () => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO guest_sessions (token_hash, expires_at)
       VALUES ('sowing-reminder-guest', NOW() + INTERVAL '30 days') RETURNING id`,
    );
    const gardenId = await createGarden(null, rows[0].id);
    const bedId = await createBed(gardenId);
    const tomato = await createCambiumSeed('Tomato', 6, 'none');
    await createPlanting(bedId, gardenId, { cambiumSeedId: tomato });

    expect(await runSowingReminders(at('2027-03-01'))).toEqual({ affected: 0, failed: 0 });
    expect(await notifications()).toEqual([]);
  });

  it('uses the owner\'s custom date for the garden over the derived window', async () => {
    const { ownerId, gardenId, bedId } = await setup();
    const tomato = await createCambiumSeed('Tomato', 6, 'none');
    await createPlanting(bedId, gardenId, { cambiumSeedId: tomato });
    await pool.query(
      `INSERT INTO user_seed_preferences (account_id, garden_id, cambium_seed_id, custom_indoor_start_date)
       VALUES ($1, $2, $3, '2027-03-20')`,
      [ownerId, gardenId, tomato],
    );

    // The derived window (02-25..03-11) would be open; the custom date isn't yet.
    expect(await runSowingReminders(at('2027-03-01'))).toEqual({ affected: 0, failed: 0 });
    expect(await runSowingReminders(at('2027-03-19'))).toEqual({ affected: 1, failed: 0 });
    const [n] = await notifications();
    expect(n.payload).toEqual({
      gardenId,
      gardenName: 'Reminder Garden',
      season: SEASON,
      // A one-day custom window is open only on its day, so its open and
      // closing reminders go out together the night before it.
      open: { indoor_start: ['Tomato'] },
      closing: [{ name: 'Tomato', windowKind: 'indoor_start', endsOn: '2027-03-20' }],
    });
  });

  it('sends next season\'s reminders a later night when this season already sent one', async () => {
    // Frost 01-20: next season's tomato starts indoors 2027-12-02..12-16.
    const ownerId = await createAccount('2027-01-20');
    const gardenId = await createGarden(ownerId);
    const bedNow = await createBed(gardenId, SEASON);
    const bedNext = await createBed(gardenId, SEASON + 1);
    const tomato = await createCambiumSeed('Tomato', 6, 'none');
    const pepper = await createCambiumSeed('Pepper', 6, 'none');
    await createPlanting(bedNext, gardenId, { cambiumSeedId: tomato, season: SEASON + 1 });
    await createPlanting(bedNow, gardenId, { cambiumSeedId: pepper, season: SEASON });
    // This season's pepper has a custom indoor date that falls on 12-06.
    await pool.query(
      `INSERT INTO user_seed_preferences (account_id, garden_id, cambium_seed_id, custom_indoor_start_date)
       VALUES ($1, $2, $3, '2027-12-06')`,
      [ownerId, gardenId, pepper],
    );

    expect(await runSowingReminders(at('2027-12-05'))).toEqual({ affected: 1, failed: 0 });
    let all = await notifications();
    expect(all).toHaveLength(1);
    expect(all[0].payload).toMatchObject({ season: SEASON, open: { indoor_start: ['Pepper'] } });

    expect(await runSowingReminders(at('2027-12-05'))).toEqual({ affected: 1, failed: 0 });
    all = await notifications();
    expect(all).toHaveLength(2);
    expect(all[1].payload).toEqual({
      gardenId,
      gardenName: 'Reminder Garden',
      season: SEASON + 1,
      open: { indoor_start: ['Tomato'] },
    });
  });

  it('skips a seed that has no window', async () => {
    const ownerId = await createAccount(null);
    const gardenId = await createGarden(ownerId);
    const bedId = await createBed(gardenId);
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO cambium.seeds (common_name, source) VALUES ('Mystery', 'editorial') RETURNING id`,
    );
    await createPlanting(bedId, gardenId, { cambiumSeedId: rows[0].id });

    expect(await runSowingReminders(at('2027-03-01'))).toEqual({ affected: 0, failed: 0 });
  });

  it('never sends the closing reminder for a custom date before the open one', async () => {
    const { ownerId, gardenId, bedId } = await setup();
    const tomato = await createCambiumSeed('Tomato', 6, 'none');
    await createPlanting(bedId, gardenId, { cambiumSeedId: tomato });
    await pool.query(
      `INSERT INTO user_seed_preferences (account_id, garden_id, cambium_seed_id, custom_indoor_start_date)
       VALUES ($1, $2, $3, '2027-03-20')`,
      [ownerId, gardenId, tomato],
    );

    // Every night from end - 8 (03-12) through the end (03-20).
    const sentOn: string[] = [];
    for (let day = 12; day <= 20; day++) {
      const date = `2027-03-${day}`;
      const { affected } = await runSowingReminders(at(date));
      if (affected > 0) sentOn.push(date);
    }

    // The window opens on tomorrow = 03-20, so both go out on 03-19, in one notice.
    expect(sentOn).toEqual(['2027-03-19']);
    const all = await notifications();
    expect(all).toHaveLength(1);
    expect(all[0].payload).toEqual({
      gardenId,
      gardenName: 'Reminder Garden',
      season: SEASON,
      open: { indoor_start: ['Tomato'] },
      closing: [{ name: 'Tomato', windowKind: 'indoor_start', endsOn: '2027-03-20' }],
    });
  });

  it('treats a personal seed planted under different Cambium links as one seed', async () => {
    const { ownerId, gardenId, bedId } = await setup();
    const linkA = await createCambiumSeed('Tomato A', 6, 'none');
    const linkB = await createCambiumSeed('Tomato B', 6, 'none');
    const tomato = await createPersonalSeed(ownerId, 'Tomato', 6, 'none');
    // The growing planting sorts first; the planned one must still count.
    await createPlanting(bedId, gardenId, {
      seedId: tomato,
      cambiumSeedId: linkA,
      state: 'growing',
      plantingDate: '2027-02-20',
    });
    await createPlanting(bedId, gardenId, { seedId: tomato, cambiumSeedId: linkB });

    expect(await runSowingReminders(at('2027-03-01'))).toEqual({ affected: 1, failed: 0 });
    const [n] = await notifications();
    expect(n.payload).toEqual({
      gardenId,
      gardenName: 'Reminder Garden',
      season: SEASON,
      open: { indoor_start: ['Tomato'] },
    });
    const { rows } = await pool.query('SELECT seed_key FROM sowing_reminders_sent');
    expect(rows).toEqual([{ seed_key: `seed:${tomato}` }]);
  });
});
