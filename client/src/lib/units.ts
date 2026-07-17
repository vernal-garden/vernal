// client/src/lib/units.ts

export type UnitSystem = 'imperial' | 'metric';

// ── Raw numeric conversions (for charts / math) ────────────────────────────────

export function celsiusToDisplay(c: number, units: UnitSystem): number {
  return units === 'imperial' ? (c * 9) / 5 + 32 : c;
}

export function msToDisplay(ms: number, units: UnitSystem): number {
  return units === 'imperial' ? ms * 2.2369362920544 : ms; // m/s → mph
}

export function mmToDisplay(mm: number, units: UnitSystem): number {
  return units === 'imperial' ? mm / 25.4 : mm; // mm → in
}

export function hpaToDisplay(hpa: number, units: UnitSystem): number {
  return units === 'imperial' ? hpa * 0.0295299830714 : hpa; // hPa → inHg
}

// ── Formatters (for display strings) ────────────────────────────────────────────

export function formatTemp(c: number | null, units: UnitSystem): string | null {
  if (c === null) return null;
  const suffix = units === 'imperial' ? '°F' : '°C';
  return `${Math.round(celsiusToDisplay(c, units))}${suffix}`;
}

export function formatWindSpeed(ms: number | null, units: UnitSystem): string | null {
  if (ms === null) return null;
  const suffix = units === 'imperial' ? 'mph' : 'm/s';
  return `${msToDisplay(ms, units).toFixed(1)} ${suffix}`;
}

export function formatPrecip(mm: number | null, units: UnitSystem): string | null {
  if (mm === null) return null;
  const suffix = units === 'imperial' ? 'in' : 'mm';
  const digits = units === 'imperial' ? 2 : 1;
  return `${mmToDisplay(mm, units).toFixed(digits)} ${suffix}`;
}

export function formatPressure(hpa: number | null, units: UnitSystem): string | null {
  if (hpa === null) return null;
  const suffix = units === 'imperial' ? 'inHg' : 'hPa';
  const digits = units === 'imperial' ? 2 : 0;
  return `${hpaToDisplay(hpa, units).toFixed(digits)} ${suffix}`;
}

export function formatHumidity(pct: number | null): string | null {
  if (pct === null) return null;
  return `${Math.round(pct)}%`;
}

export function formatUvIndex(uv: number | null): string | null {
  if (uv === null) return null;
  return uv.toFixed(1);
}

export function unitLabel(units: UnitSystem, kind: 'temp' | 'precip'): string {
  if (kind === 'temp') return units === 'imperial' ? '°F' : '°C';
  return units === 'imperial' ? 'in' : 'mm';
}
