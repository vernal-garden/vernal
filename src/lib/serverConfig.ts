import path from 'path';

// Deployment switches, read once at startup. Every default matches how
// vernal.garden runs today; self-hosters change them via environment variables.
export interface ServerConfig {
  billing: 'stripe' | 'off';
  mail: 'smtp' | 'off';
  media: 's3' | 'local';
  googleSignIn: boolean;
  weather: boolean;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
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

  loaded = {
    billing,
    mail,
    media,
    googleSignIn: Boolean(googleId && googleSecret),
    weather: Boolean(read(env, 'VISUAL_CROSSING_API_KEY')),
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
