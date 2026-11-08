// RFC 4180 quoting, plus a leading quote on anything a spreadsheet would read
// as a formula. null is an empty field.
export function csvCell(v: string | number | boolean | null): string {
  let s = v === null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// One CSV line (no line ending).
export function csvRow(values: Array<string | number | boolean | null>): string {
  return values.map(csvCell).join(',');
}
