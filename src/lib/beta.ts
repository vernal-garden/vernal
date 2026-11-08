import type { Pool, PoolClient } from 'pg';
import { db } from './db';
import { BETA_TERMS_VERSION } from './legal';

export interface BetaSettings {
  gateOn: boolean;
  guestModeOn: boolean;
  supporterAccessOn: boolean;
  gateFirstOnAt: Date | null;
}

interface SettingsRow {
  gate_on: boolean;
  guest_mode_on: boolean;
  supporter_access_on: boolean;
  gate_first_on_at: Date | null;
}

const CACHE_MS = 30_000;
let cached: { value: BetaSettings; at: number } | null = null;
// Bumped by invalidateBetaSettings so a read already in flight cannot write back a stale value.
let generation = 0;

function toSettings(row: SettingsRow): BetaSettings {
  return {
    gateOn: row.gate_on,
    guestModeOn: row.guest_mode_on,
    supporterAccessOn: row.supporter_access_on,
    gateFirstOnAt: row.gate_first_on_at,
  };
}

const SETTINGS_SQL =
  'SELECT gate_on, guest_mode_on, supporter_access_on, gate_first_on_at FROM beta_settings WHERE id = 1';

// Uncached read of the settings row, on a Pool or a transaction's client.
export async function readBetaSettings(runner: Pool | PoolClient): Promise<BetaSettings> {
  const { rows } = await runner.query<SettingsRow>(SETTINGS_SQL);
  return toSettings(rows[0]);
}

// One pm2 instance, so an in-process cache is valid. Admin changes call
// invalidateBetaSettings() after COMMIT; otherwise a change shows within 30s.
export async function getBetaSettings(): Promise<BetaSettings> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const started = generation;
  const value = await readBetaSettings(db);
  if (generation === started) cached = { value, at: Date.now() };
  return value;
}

export function invalidateBetaSettings(): void {
  generation++;
  cached = null;
}

// Supporter access for a participant, while the switch is on.
export function betaAccessApplies(participantAt: Date | string | null, s: BetaSettings): boolean {
  return participantAt !== null && s.supporterAccessOn;
}

// A participant who has not accepted the current beta terms version.
export function betaTermsPending(
  participantAt: Date | string | null,
  acceptedVersion: string | null,
): boolean {
  return participantAt !== null && acceptedVersion !== BETA_TERMS_VERSION;
}

export type SignupDecision = { allowed: false } | { allowed: true; participant: boolean };

// Whether this email may create an account now. The email is already lowercased
// by the caller. Settings are read fresh (not cached), so a sign-up never races
// a gate change.
export async function decideSignup(
  client: PoolClient,
  email: string,
  guestSessionId: string | null,
): Promise<SignupDecision> {
  const s = await readBetaSettings(client);

  const { rowCount } = await client.query('SELECT 1 FROM beta_invites WHERE email = $1', [email]);
  const invited = (rowCount ?? 0) > 0;

  if (!s.gateOn) return { allowed: true, participant: invited };
  if (invited) return { allowed: true, participant: true };

  // Gate on, not invited: a guest whose session was open when the gate first
  // went on keeps the right to claim their garden.
  if (guestSessionId && s.gateFirstOnAt) {
    const { rowCount: guestCount } = await client.query(
      `SELECT 1 FROM guest_sessions
        WHERE id = $1 AND account_id IS NULL AND migrated_at IS NULL
          AND created_at < $2 AND expires_at > $2`,
      [guestSessionId, s.gateFirstOnAt],
    );
    if ((guestCount ?? 0) > 0) return { allowed: true, participant: true };
  }
  return { allowed: false };
}
