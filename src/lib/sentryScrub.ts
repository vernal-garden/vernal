import type { Event } from '@sentry/node';

// Last line of defence before an event leaves the process. The SDK's
// dataCollection settings (src/instrument.ts) should already omit all of this;
// this guards against SDK default changes and manually attached context.
const SENSITIVE_KEY = /password|token|secret|authorization|cookie/i;
const QUERY_KEYS = new Set(['query_string', 'http.query', 'url.query']);
const URL_KEYS = new Set(['url', 'to', 'from', 'url.full', 'http.url', 'http.target']);
const MAX_DEPTH = 8;

function stripQuery(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const cut = value.search(/[?#]/);
  return cut === -1 ? value : value.slice(0, cut);
}

// Twin of EMAIL in client/src/lib/sentryEmail.ts; keep the two in step.
// Route errors reach Sentry through logger.error, and an error's message can
// quote an address (a mail transport error, say).
const EMAIL = /[^\s@<>"'()[\]]+@[^\s@<>"'()[\]]+\.[^\s@<>"'()[\]]+/g;

// replace() with a /g regex resets lastIndex, so repeated calls are safe.
export function maskEmails(s: string): string {
  return s.replace(EMAIL, '[EMAIL]');
}

const TOKEN_PARAM = /([?&](?:token|code|key)=)[^&\s#]+/gi;

function scrubValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return maskEmails(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth > MAX_DEPTH) return '[Truncated]';
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(key) || QUERY_KEYS.has(key)) out[key] = '[REDACTED]';
    else if (URL_KEYS.has(key)) {
      const stripped = stripQuery(v);
      out[key] = typeof stripped === 'string' ? maskEmails(stripped) : scrubValue(stripped, depth + 1);
    }
    else out[key] = scrubValue(v, depth + 1);
  }
  return out;
}

export function scrubEvent<T extends Event>(event: T): T {
  delete event.user;
  if (typeof event.message === 'string') event.message = maskEmails(event.message);
  for (const ex of event.exception?.values ?? []) {
    if (typeof ex.value === 'string') ex.value = maskEmails(ex.value);
  }
  if (typeof event.transaction === 'string') event.transaction = maskEmails(stripQuery(event.transaction) as string);
  if (event.request) {
    delete event.request.data;
    delete event.request.cookies;
    delete event.request.headers;
    delete event.request.query_string;
    if (event.request.url) event.request.url = maskEmails(stripQuery(event.request.url) as string);
  }
  if (event.breadcrumbs) {
    for (const crumb of event.breadcrumbs) {
      if (typeof crumb.message === 'string') {
        crumb.message = maskEmails(crumb.message.replace(TOKEN_PARAM, '$1[REDACTED]'));
      }
      if (crumb.data) crumb.data = scrubValue(crumb.data, 0) as typeof crumb.data;
      // Console breadcrumbs carry raw log arguments (e.g. dev-mode email bodies with links).
      if (crumb.category === 'console' && crumb.data) delete crumb.data.arguments;
    }
  }
  if (event.tags) {
    for (const [k, v] of Object.entries(event.tags)) {
      if (typeof v === 'string') event.tags[k] = maskEmails(v);
    }
  }
  if (event.extra) event.extra = scrubValue(event.extra, 0) as typeof event.extra;
  if (event.contexts) event.contexts = scrubValue(event.contexts, 0) as typeof event.contexts;
  const spans = (event as { spans?: Array<{ description?: unknown; data?: Record<string, unknown> }> }).spans;
  if (spans) {
    for (const span of spans) {
      if (typeof span.description === 'string') span.description = maskEmails(stripQuery(span.description) as string);
      if (span.data) span.data = scrubValue(span.data, 0) as Record<string, unknown>;
    }
  }
  return event;
}
