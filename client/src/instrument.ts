import * as Sentry from '@sentry/react';

// Removes token-bearing query params (reset, email-confirm, verify links).
function stripTokens(value: unknown): unknown {
  return typeof value === 'string' ? value.replace(/([?&])token=[^&#]*/g, '$1token=[REDACTED]') : value;
}

function scrubData(data: Record<string, unknown> | undefined): void {
  if (!data) return;
  for (const key of ['url', 'from', 'to']) {
    if (key in data) data[key] = stripTokens(data[key]);
  }
}

const SPAN_DATA_KEYS = ['http.query', 'url.query', 'url.full', 'http.url', 'url'];

function scrubSpanData(data: Record<string, unknown> | undefined): void {
  if (!data) return;
  for (const key of SPAN_DATA_KEYS) {
    if (key in data) data[key] = stripTokens(data[key]);
  }
}

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
  integrations: [
    Sentry.browserTracingIntegration(),
  ],
  beforeSend(event) {
    if (event.request?.url) event.request.url = stripTokens(event.request.url) as string;
    event.breadcrumbs?.forEach((crumb) => scrubData(crumb.data));
    return event;
  },
  beforeSendTransaction(event) {
    if (event.request?.url) event.request.url = stripTokens(event.request.url) as string;
    if (event.transaction) event.transaction = stripTokens(event.transaction) as string;
    event.spans?.forEach((span) => {
      if (span.description) span.description = stripTokens(span.description) as string;
      scrubSpanData(span.data as Record<string, unknown> | undefined);
    });
    scrubSpanData(event.contexts?.trace?.data as Record<string, unknown> | undefined);
    return event;
  },
  beforeBreadcrumb(crumb) {
    scrubData(crumb.data);
    return crumb;
  },
});
