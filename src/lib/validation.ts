// Shared request-validation helpers for the Vernal API.

const NUMERIC_ID_RE = /^[1-9]\d*$/;

// True when v is a positive integer string with no leading zeros — the shape
// every serial primary key takes once it's landed in req.params. Rejects '',
// '0', '012', '-1', '1.5', '1e5', and 'NaN' (unlike Number()/parseInt(), which
// coerce all of those). One canonical form per id, so R2 keys built from
// params can't alias ('012' and '12' naming the same row).
export function isNumericId(v: unknown): v is string {
  return typeof v === 'string' && NUMERIC_ID_RE.test(v);
}

const EMAIL_MAX_LENGTH = 254;
// Local part up to 64 non-space/non-@ chars; domain is dot-separated labels with
// no empty labels. No two quantifiers can match the same characters, so the
// match is linear — the old /^[^\s@]+@[^\s@]+\.[^\s@]+$/ was quadratic.
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@.]+(?:\.[^\s@.]+)+$/;

// True when v is a plausibly valid email address. The length check runs before
// the regex so oversized input never reaches it.
export function isValidEmail(v: unknown): v is string {
  return typeof v === 'string' && v.length <= EMAIL_MAX_LENGTH && EMAIL_RE.test(v);
}
