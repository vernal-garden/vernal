// Masks email addresses in browser Sentry events before they leave the page.
// Browser envelopes pass through src/routes/sentryRelay.ts byte for byte, so
// this is the only place they can be scrubbed (privacy policy: error reports
// never include an email address). Pure module: no @sentry/* or DOM imports,
// so the root test suite can run it under node.

// Twin of EMAIL in src/lib/sentryScrub.ts; keep the two in step.
const EMAIL = /[^\s@<>"'()[\]]+@[^\s@<>"'()[\]]+\.[^\s@<>"'()[\]]+/g;

const MAX_DEPTH = 8;

// replace() with a /g regex resets lastIndex, so repeated calls are safe.
export function maskEmails(s: string): string {
  return s.replace(EMAIL, '[EMAIL]');
}

export function maskEmailsDeep(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return maskEmails(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth > MAX_DEPTH) return '[Truncated]';
  if (Array.isArray(value)) return value.map((v) => maskEmailsDeep(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = maskEmailsDeep(v, depth + 1);
  }
  return out;
}

// The parts of a Sentry event this module touches. All optional so the SDK's
// ErrorEvent and TransactionEvent satisfy it.
export interface BrowserEventLike {
  message?: string;
  transaction?: string;
  exception?: { values?: Array<{ value?: string }> };
  breadcrumbs?: Array<{ message?: string; data?: unknown }>;
  extra?: unknown;
  contexts?: unknown;
  tags?: unknown;
  request?: { url?: string };
  spans?: Array<{ description?: string; data?: unknown }>;
}

// Cuts at the first ? or #, like stripQuery in src/lib/sentryScrub.ts. Query
// strings can carry an address the EMAIL regex misses (percent-encoded @, as in
// /api/admin/accounts?email=jane%40example.com) and one-time tokens.
export function stripQuery(s: string): string {
  const cut = s.search(/[?#]/);
  return cut === -1 ? s : s.slice(0, cut);
}

const URL_DATA_KEYS = ['url', 'from', 'to', 'url.full', 'http.url', 'http.target'];
const QUERY_DATA_KEYS = ['http.query', 'url.query'];

// Breadcrumb and span data: strip the query from URL-valued keys and redact the
// query-valued ones, matching the server's scrubValue.
export function stripDataQueries(data: unknown): void {
  if (data === null || typeof data !== 'object') return;
  const d = data as Record<string, unknown>;
  for (const key of URL_DATA_KEYS) {
    const v = d[key];
    if (typeof v === 'string') d[key] = stripQuery(v);
  }
  for (const key of QUERY_DATA_KEYS) {
    if (key in d) d[key] = '[REDACTED]';
  }
}

export function stripBreadcrumbQueries<T extends object>(crumb: T): T {
  stripDataQueries((crumb as { data?: unknown }).data);
  return crumb;
}

// Strips queries from every URL an event carries. Run before the email masking.
export function stripEventQueries<T extends BrowserEventLike>(event: T): T {
  const e: BrowserEventLike = event;
  if (typeof e.transaction === 'string') e.transaction = stripQuery(e.transaction);
  if (typeof e.request?.url === 'string') e.request.url = stripQuery(e.request.url);
  for (const crumb of e.breadcrumbs ?? []) stripDataQueries(crumb.data);
  for (const span of e.spans ?? []) {
    if (typeof span.description === 'string') span.description = stripQuery(span.description);
    stripDataQueries(span.data);
  }
  const trace = (e.contexts as { trace?: { data?: unknown } } | undefined)?.trace;
  if (trace) stripDataQueries(trace.data);
  return event;
}

// `object` rather than a weak all-optional type: Sentry's Breadcrumb interface has
// no index signature and a crumb like { category } shares no property with one.
export function scrubBreadcrumbEmails<T extends object>(crumb: T): T {
  const c = crumb as { message?: unknown; data?: unknown };
  if (typeof c.message === 'string') c.message = maskEmails(c.message);
  if (c.data !== undefined && c.data !== null) c.data = maskEmailsDeep(c.data);
  return crumb;
}

export function scrubEventEmails<T extends BrowserEventLike>(event: T): T {
  const e: BrowserEventLike = event;
  if (typeof e.message === 'string') e.message = maskEmails(e.message);
  for (const ex of e.exception?.values ?? []) {
    if (typeof ex.value === 'string') ex.value = maskEmails(ex.value);
  }
  for (const crumb of e.breadcrumbs ?? []) scrubBreadcrumbEmails(crumb);
  if (e.extra !== undefined) e.extra = maskEmailsDeep(e.extra);
  if (e.contexts !== undefined) e.contexts = maskEmailsDeep(e.contexts);
  if (e.tags !== undefined) e.tags = maskEmailsDeep(e.tags);
  if (typeof e.transaction === 'string') e.transaction = maskEmails(e.transaction);
  if (typeof e.request?.url === 'string') e.request.url = maskEmails(e.request.url);
  for (const span of e.spans ?? []) {
    if (typeof span.description === 'string') span.description = maskEmails(span.description);
    if (span.data !== undefined) span.data = maskEmailsDeep(span.data);
  }
  return event;
}
