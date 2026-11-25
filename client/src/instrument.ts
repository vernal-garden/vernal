import * as Sentry from '@sentry/react';
import {
  scrubBreadcrumbEmails,
  scrubEventEmails,
  stripBreadcrumbQueries,
  stripEventQueries,
} from './lib/sentryEmail';

// Capture the one-time token before Sentry.init so it never reaches error or
// performance reports, then remove it from the address bar straight away.
let urlToken: { token: string; pathname: string } | null = null;
try {
  const url = new URL(window.location.href);
  const t = url.searchParams.get('token');
  if (t !== null) {
    urlToken = { token: t, pathname: window.location.pathname };
    window.history.replaceState(window.history.state, '', window.location.pathname + window.location.hash);
  }
} catch {
  urlToken = null;
}

/**
 * Returns the token stashed from the initial URL, only for the pathname it
 * arrived on. Not cleared on read: StrictMode runs initializers twice.
 */
export function getUrlToken(pathname: string): string | null {
  return urlToken && urlToken.pathname === pathname ? urlToken.token : null;
}

Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN,
  // Envelopes go through our own API (POST /api/relay) instead of Sentry's
  // ingest host, which ad blockers block. Same base as lib/api.ts.
  tunnel: `${import.meta.env.VITE_API_BASE_URL ?? ''}/api/relay`,
  environment: import.meta.env.VITE_SENTRY_ENVIRONMENT ?? 'development',
  tracesSampleRate: 0.1,
  enabled: !!import.meta.env.VITE_SENTRY_DSN,
  // Every field explicit: a partial dataCollection object enables the
  // all-on defaults for anything omitted.
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
  // CultureContext sends the browser's time zone and locale; off by privacy policy (GC, 2026-11-24).
  integrations: (defaults) => [
    ...defaults.filter((i) => i.name !== 'CultureContext'),
    Sentry.browserTracingIntegration(),
  ],
  // Query strings (reset tokens, searched addresses) are stripped everywhere a
  // URL is recorded, then any remaining address is masked.
  beforeSend(event) {
    return scrubEventEmails(stripEventQueries(event));
  },
  beforeSendTransaction(event) {
    return scrubEventEmails(stripEventQueries(event));
  },
  beforeBreadcrumb(crumb) {
    return scrubBreadcrumbEmails(stripBreadcrumbQueries(crumb));
  },
});
