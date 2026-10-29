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

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const billing = choice(env, 'BILLING', ['stripe', 'off'] as const, 'stripe');
  const mail = choice(env, 'MAIL', ['smtp', 'off'] as const, 'smtp');
  const media = choice(env, 'MEDIA_STORAGE', ['s3', 'local'] as const, 's3');

  if (billing === 'stripe' && !read(env, 'STRIPE_SECRET_KEY')) {
    throw new ConfigError(
      'STRIPE_SECRET_KEY is not set. Set it, or set BILLING=off to run without payments (every account then gets every feature).',
    );
  }

  // Development without SMTP_HOST keeps the console fallback.
  if (mail === 'smtp' && env.NODE_ENV === 'production' && !read(env, 'SMTP_HOST')) {
    throw new ConfigError('SMTP_HOST is not set. Set it, or set MAIL=off to run without email.');
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
