const MAX_LENGTH = 512;
// Backslash (browsers treat it like '/'), '@' (userinfo), and control characters.
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\\@\u0000-\u001f\u007f]/;

// Returns `raw` only if it is a same-origin path ("/..." but not "//..."),
// otherwise "/". The result is appended to FRONTEND_URL, so anything else
// (e.g. "@evil.com", ".evil.com") would change the redirect's host.
export function safeReturnTo(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_LENGTH) return '/';
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/';
  if (FORBIDDEN.test(raw)) return '/';
  return raw;
}
