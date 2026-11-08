import path from 'path';
import { ConfigError } from './configError';
import { dbSslConfig } from './dbSsl';

export { ConfigError };

// Where /api/relay may forward the browser's Sentry envelopes: the one project
// named by SENTRY_CLIENT_DSN.
export interface SentryRelayTarget {
  host: string;
  projectId: string;
  publicKey: string;
}

// Deployment switches, read once at startup. Every default matches how
// vernal.garden runs today; self-hosters change them via environment variables.
export interface ServerConfig {
  billing: 'stripe' | 'off';
  mail: 'smtp' | 'off';
  media: 's3' | 'local';
  googleSignIn: boolean;
  weather: boolean;
  // From this instant the private beta page stops taking applications.
  betaApplicationsCloseAt: Date;
  // The private beta ends at this instant; activity after it is not tracked.
  betaEndsAt: Date;
  // Set only when SENTRY_CLIENT_DSN is set; absent means the relay is off.
  sentryRelay?: SentryRelayTarget;
}

let loaded: ServerConfig | null = null;

// A blank or whitespace-only value counts as not set.
function read(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

function choice<T extends string>(env: NodeJS.ProcessEnv, key: string, allowed: readonly T[], fallback: T): T {
  const value = read(env, key);
  if (value === undefined) return fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new ConfigError(`${key} must be one of: ${allowed.join(', ')} (got "${value}").`);
}

// An ISO 8601 instant with a UTC offset and a real calendar day. Names the
// variable, never echoes the value.
function readOffsetInstant(env: NodeJS.ProcessEnv, key: string, fallback: string, example: string): Date {
  const value = read(env, key) ?? fallback;
  const instant = new Date(value);
  const day = value.slice(0, 10);
  const dayCheck = new Date(`${day}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value) ||
    Number.isNaN(instant.getTime()) ||
    Number.isNaN(dayCheck.getTime()) ||
    dayCheck.toISOString().slice(0, 10) !== day
  ) {
    throw new ConfigError(`${key} must be an ISO 8601 date and time with a UTC offset (for example ${example}).`);
  }
  return instant;
}

// Relaxes security defaults for console mail only; unset counts as production.
export function isLocalEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const nodeEnv = read(env, 'NODE_ENV');
  return nodeEnv === 'development' || nodeEnv === 'test';
}

// Cookies are secure iff the frontend is https; with no FRONTEND_URL, secure unless local env. Unparseable fails closed.
export function secureCookies(env: NodeJS.ProcessEnv = process.env): boolean {
  const frontend = read(env, 'FRONTEND_URL');
  if (frontend === undefined) return !isLocalEnv(env);
  try {
    return new URL(frontend).protocol === 'https:';
  } catch {
    return true;
  }
}

// Links in emails and the OAuth redirects are built from these. Names the
// variable, never echoes the value.
function requireHttpUrl(env: NodeJS.ProcessEnv, key: string): void {
  const value = read(env, key);
  if (value === undefined) {
    throw new ConfigError(`${key} is not set. Set it to the site's public URL (https://…).`);
  }
  let protocol = '';
  try {
    protocol = new URL(value).protocol;
  } catch {
    // reported below
  }
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new ConfigError(`${key} must be an http(s) URL.`);
  }
}

// https://<public key>@<host>/<project id>, the shape of every Sentry DSN.
// Also used by the relay to read the dsn in each envelope's header.
export function parseSentryDsn(value: string): SentryRelayTarget | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const match = /^\/(\d+)\/?$/.exec(url.pathname);
  if (url.protocol !== 'https:' || !url.username || !match) return null;
  return { host: url.host, projectId: match[1], publicKey: url.username };
}

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const nodeEnv = read(env, 'NODE_ENV');
  if (nodeEnv !== undefined) {
    if (!(['production', 'development', 'test'] as readonly string[]).includes(nodeEnv)) {
      throw new ConfigError(`NODE_ENV must be one of: production, development, test (got "${nodeEnv}").`);
    }
    if (nodeEnv === 'test' && !env.VITEST && env.E2E_LISTEN !== 'true') {
      throw new ConfigError(
        'NODE_ENV=test is only for the test suites and turns off rate limits. Set NODE_ENV=production (or development on a local machine).',
      );
    }
  }

  const billing = choice(env, 'BILLING', ['stripe', 'off'] as const, 'stripe');
  const mail = choice(env, 'MAIL_MODE', ['smtp', 'off'] as const, 'smtp');
  const media = choice(env, 'MEDIA_STORAGE', ['s3', 'local'] as const, 's3');

  if (billing === 'stripe' && !read(env, 'STRIPE_SECRET_KEY')) {
    throw new ConfigError(
      'STRIPE_SECRET_KEY is not set. Set it, or set BILLING=off to run without payments (every account then gets every feature).',
    );
  }

  // Only a local env (development/test) may run without SMTP_HOST, and then mail
  // is printed to the console. Unset NODE_ENV counts as production.
  if (mail === 'smtp' && !isLocalEnv(env) && !read(env, 'SMTP_HOST')) {
    throw new ConfigError(
      'SMTP_HOST is not set. Set it, set MAIL_MODE=off to run without email, or set NODE_ENV=development to print mail to the console on a local machine.',
    );
  }

  // Unset NODE_ENV counts as production, as for SMTP_HOST above.
  if (!isLocalEnv(env)) {
    requireHttpUrl(env, 'FRONTEND_URL');
    requireHttpUrl(env, 'APP_URL');
  }

  if (media === 'local') {
    const dir = read(env, 'MEDIA_DIR');
    if (!dir) {
      throw new ConfigError('MEDIA_DIR is not set. It is required when MEDIA_STORAGE=local and must be an absolute path.');
    }
    if (!path.isAbsolute(dir)) {
      throw new ConfigError(`MEDIA_DIR must be an absolute path (got "${dir}").`);
    }
  }

  const googleId = read(env, 'GOOGLE_CLIENT_ID');
  const googleSecret = read(env, 'GOOGLE_CLIENT_SECRET');
  if (Boolean(googleId) !== Boolean(googleSecret)) {
    const missing = googleId ? 'GOOGLE_CLIENT_SECRET' : 'GOOGLE_CLIENT_ID';
    throw new ConfigError(
      `${missing} is not set. Set both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to enable Google sign-in, or leave both blank to turn it off.`,
    );
  }

  // Validated here so a bad DB TLS setting stops startup with one line (via
  // loadConfig) instead of a stack trace from db.ts.
  dbSslConfig(env);

  // The browser's DSN, for /api/relay. Names the variable, never echoes the value.
  const clientDsn = read(env, 'SENTRY_CLIENT_DSN');
  const sentryRelay = clientDsn === undefined ? undefined : parseSentryDsn(clientDsn);
  if (sentryRelay === null) {
    throw new ConfigError('SENTRY_CLIENT_DSN must be a Sentry DSN (https://<key>@<host>/<project id>).');
  }

  const closeAt = readOffsetInstant(env, 'BETA_APPLICATIONS_CLOSE_AT', '2027-01-01T00:00:00-08:00', '2027-01-01T00:00:00-08:00');
  const endsAt = readOffsetInstant(env, 'BETA_ENDS_AT', '2027-01-30T00:00:00-08:00', '2027-01-30T00:00:00-08:00');

  loaded = {
    billing,
    mail,
    media,
    googleSignIn: Boolean(googleId && googleSecret),
    weather: Boolean(read(env, 'VISUAL_CROSSING_API_KEY')),
    betaApplicationsCloseAt: closeAt,
    betaEndsAt: endsAt,
    ...(sentryRelay ? { sentryRelay } : {}),
  };
  return loaded;
}

export function getServerConfig(): ServerConfig {
  if (!loaded) throw new Error('Server config has not been loaded. Call loadServerConfig() at startup.');
  return loaded;
}

// Lives here (not in mailer.ts) so routes can check it without importing the
// mailer, which several test suites replace wholesale.
export function isMailEnabled(): boolean {
  return getServerConfig().mail === 'smtp';
}

export function setServerConfigForTests(c: ServerConfig): void {
  loaded = c;
}
