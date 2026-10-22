// Shared request-validation helpers for the Vernal API.

const NUMERIC_ID_RE = /^[1-9]\d{0,9}$/;
const PG_INT4_MAX = 2_147_483_647;

// True when v is a positive integer string with no leading zeros — the shape
// every serial primary key takes once it's landed in req.params. Rejects '',
// '0', '012', '-1', '1.5', '1e5', and 'NaN' (unlike Number()/parseInt(), which
// coerce all of those). One canonical form per id, so R2 keys built from
// params can't alias ('012' and '12' naming the same row). Also rejects
// anything past int4 (every id column is SERIAL/INTEGER), so an oversized id
// is a 400 rather than a Postgres "out of range" 500.
export function isNumericId(v: unknown): v is string {
  return typeof v === 'string' && NUMERIC_ID_RE.test(v) && Number(v) <= PG_INT4_MAX;
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

export type TextFieldResult = { ok: true; value: string | null } | { ok: false; error: string };

// Trims and length-checks a string field. Absent (undefined, null or blank) is
// null unless required. Every stored text column is TEXT, so the cap lives here.
export function textField(
  value: unknown,
  opts: { field: string; max: number; required?: boolean },
): TextFieldResult {
  if (value === undefined || value === null) {
    return opts.required ? { ok: false, error: `${opts.field} is required` } : { ok: true, value: null };
  }
  if (typeof value !== 'string') return { ok: false, error: `${opts.field} must be a string` };
  const trimmed = value.trim();
  if (trimmed === '') {
    return opts.required ? { ok: false, error: `${opts.field} is required` } : { ok: true, value: null };
  }
  if (trimmed.length > opts.max) {
    return { ok: false, error: `${opts.field} must be ${opts.max} characters or fewer` };
  }
  return { ok: true, value: trimmed };
}

export type NumberFieldResult = { ok: true; value: number | null } | { ok: false; error: string };

// Parses an optional numeric field (number or numeric string). Absent (undefined,
// null or '') is null; anything non-finite, non-numeric or outside min..max is an
// error. With `integer`, fractions are an error too (for INTEGER columns).
export function numberField(
  value: unknown,
  opts: { field: string; min: number; max: number; integer?: boolean },
): NumberFieldResult {
  if (value === undefined || value === null || value === '') return { ok: true, value: null };
  const kind = opts.integer ? 'a whole number' : 'a number';
  const error = `${opts.field} must be ${kind} between ${opts.min} and ${opts.max}`;
  let n: number;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && value.trim() !== '') n = Number(value);
  else return { ok: false, error };
  if (!Number.isFinite(n) || n < opts.min || n > opts.max) return { ok: false, error };
  if (opts.integer && !Number.isInteger(n)) return { ok: false, error };
  return { ok: true, value: n };
}

// True when v is a YYYY-MM-DD string naming a real calendar date (rejects 2026-02-30).
export function isRealDate(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

// Escapes LIKE/ILIKE wildcards so user text matches literally. Use with
// `ILIKE $n ESCAPE '\'`.
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}
