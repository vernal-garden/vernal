import { Client } from 'pg';
import type { FullConfig } from '@playwright/test';

// A run killed mid-way through beta-access.spec.ts leaves the switches flipped,
// and the suites that sort before it would fail with no obvious cause. So every
// run starts from the defaults.
//
// Playwright starts the webServers before this runs. That is safe: the API is a
// new process (reuseExistingServer is off), and the readiness probes only reach
// /health and the preview server's index page, neither of which reads the
// settings, so the server's 30-second cache is still empty here. This file can't
// clear that cache (it needs an admin session, and no accounts exist yet), so
// waitForDefaults checks rather than assumes: if something did fill the cache,
// it runs out within CACHE_LIMIT_MS and the wait ends there.
const CACHE_LIMIT_MS = 35_000;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function assertLocal(name: string, connectionString: string): void {
  const url = new URL(connectionString);
  // pg lets a ?host= parameter override the host in the URL.
  if (!LOCAL_HOSTS.has(url.hostname) || url.searchParams.has('host')) {
    throw new Error(`global-setup: refusing to touch ${name}: not a local database (${url.host}${url.search})`);
  }
}

async function waitForDefaults(baseURL: string): Promise<void> {
  const deadline = Date.now() + CACHE_LIMIT_MS;
  for (;;) {
    const config = await (await fetch(`${baseURL}/api/config`)).json();
    if (config.betaGate === false && config.guestMode === true) return;
    if (Date.now() > deadline) {
      throw new Error(`global-setup: server still reports ${JSON.stringify(config)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) throw new Error('global-setup: TEST_DATABASE_URL is not set; use npm run test:e2e');
  assertLocal('TEST_DATABASE_URL', connectionString);
  // The server reads TEST_DATABASE_URL under NODE_ENV=test; a remote DATABASE_URL still means a misconfigured run.
  if (process.env.DATABASE_URL) assertLocal('DATABASE_URL', process.env.DATABASE_URL);

  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(
      `UPDATE beta_settings
          SET gate_on = false, guest_mode_on = true, supporter_access_on = true,
              gate_first_on_at = NULL, updated_at = now()
        WHERE id = 1`,
    );
    await client.query('DELETE FROM beta_invites');
  } finally {
    await client.end();
  }

  await waitForDefaults(config.projects[0].use.baseURL as string);
}
