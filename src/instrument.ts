// Must be the first import in src/index.ts — Sentry's OpenTelemetry
// instrumentation patches modules at require() time, so it has to run
// before express and anything express touches. The .env file is loaded here
// (via ./loadEnv, by explicit path) since SENTRY_DSN must already be in
// process.env by the time Sentry.init runs.
import './loadEnv';
import * as Sentry from '@sentry/node';
import { scrubEvent } from './lib/sentryScrub';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.SENTRY_ENVIRONMENT ?? 'development',
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
  enabled: !!process.env.SENTRY_DSN,
  // Every field is explicit: supplying `dataCollection` at all switches the SDK
  // from the sendDefaultPii:false profile to all-on defaults, so anything
  // omitted here would be collected (request bodies, stack locals, SQL values).
  dataCollection: {
    userInfo: false,
    cookies: false,
    httpHeaders: { request: false, response: false },
    httpBodies: [],
    urlQueryParams: false,
    databaseQueryData: false,
    stackFrameVariables: false,
    graphQL: { document: false, variables: false },
    genAI: { inputs: false, outputs: false },
  },
  integrations: [Sentry.httpIntegration({ maxIncomingRequestBodySize: 'none' })],
  beforeSend: (event) => scrubEvent(event),
  beforeSendTransaction: (event) => scrubEvent(event),
});
