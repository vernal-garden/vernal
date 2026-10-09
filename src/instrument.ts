// Must be the first import in src/index.ts — Sentry's OpenTelemetry
// instrumentation patches modules at require() time, so it has to run
// before express and anything express touches. dotenv is loaded here
// rather than relying on index.ts's later dotenv.config() call, since
// SENTRY_DSN must already be in process.env by the time Sentry.init runs.
import 'dotenv/config';
import * as Sentry from '@sentry/node';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.SENTRY_ENVIRONMENT ?? 'development',
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
  enabled: !!process.env.SENTRY_DSN,
  dataCollection: {
    userInfo: false,
  },
});
