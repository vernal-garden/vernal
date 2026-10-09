// Shared request-validation helpers for the Vernal API.

const NUMERIC_ID_RE = /^\d+$/;

// True when v is a string of one or more digits — the shape every serial
// primary key takes once it's landed in req.params. Rejects '', '-1', '1.5',
// '1e5', and 'NaN' (unlike Number()/parseInt(), which coerce all of those).
export function isNumericId(v: unknown): v is string {
  return typeof v === 'string' && NUMERIC_ID_RE.test(v);
}
