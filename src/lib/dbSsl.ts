import fs from 'fs';
import path from 'path';
import type { ConnectionOptions } from 'tls';
import { ConfigError } from './configError';

// The `ssl` option for every pg Pool (server and scripts). Certificates are
// always checked: against Node's built-in CAs (Neon), or against
// DATABASE_SSL_CA for a private CA. DATABASE_SSL=false turns TLS off, for
// Postgres on the same machine. Tests use a local database without TLS.

function read(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

function tlsOff(env: NodeJS.ProcessEnv): boolean {
  return read(env, 'NODE_ENV') === 'test' || read(env, 'DATABASE_SSL') === 'false';
}

export function dbSslConfig(env: NodeJS.ProcessEnv = process.env): false | ConnectionOptions {
  const caPath = read(env, 'DATABASE_SSL_CA');
  if (read(env, 'DATABASE_SSL') === 'false' && caPath) {
    throw new ConfigError('DATABASE_SSL=false and DATABASE_SSL_CA are both set. Remove one of them.');
  }
  if (tlsOff(env)) return false;
  if (!caPath) return { rejectUnauthorized: true };
  if (!path.isAbsolute(caPath)) {
    throw new ConfigError(`DATABASE_SSL_CA must be an absolute path (got "${caPath}").`);
  }
  let ca: string;
  try {
    ca = fs.readFileSync(caPath, 'utf8');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ConfigError(`DATABASE_SSL_CA (${caPath}) could not be read: ${reason}`);
  }
  return { rejectUnauthorized: true, ca };
}

// pg replaces the whole ssl option when the URL carries TLS parameters (and
// sslmode=no-verify or uselibpqcompat turn checking off), so they are removed:
// DATABASE_SSL / DATABASE_SSL_CA are the only TLS controls.
const URL_TLS_PARAMS = ['ssl', 'sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'uselibpqcompat'];

export function dbConnectionString(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url; // let pg report a malformed string
  }
  const removed = URL_TLS_PARAMS.filter((p) => parsed.searchParams.has(p));
  if (removed.length === 0) return url;
  for (const p of removed) parsed.searchParams.delete(p);
  console.warn(`[db] Ignoring ${removed.join(', ')} in the database URL; TLS is set by DATABASE_SSL / DATABASE_SSL_CA.`);
  return parsed.toString();
}

// For the [config] startup line.
export function dbSslMode(env: NodeJS.ProcessEnv = process.env): 'verified' | 'verified (custom CA)' | 'off' {
  if (tlsOff(env)) return 'off';
  return read(env, 'DATABASE_SSL_CA') ? 'verified (custom CA)' : 'verified';
}
