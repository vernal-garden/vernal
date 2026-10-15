import { EMPTY } from './format';

/** "commonName" → "Common name", "hardiness_zone_min" → "Hardiness zone min". */
export function humanizeKey(key: string): string {
  const words = key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Text for an arbitrary JSON value: null/empty → "—", arrays as compact JSON, objects as pretty JSON. */
export function formatFieldValue(value: unknown): string {
  if (value === null || value === undefined) return EMPTY;
  if (typeof value === 'string') return value.trim() === '' ? EMPTY : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value.length === 0 ? EMPTY : JSON.stringify(value);
  }
  if (typeof value === 'object') {
    if (Object.keys(value as object).length === 0) return EMPTY;
    return JSON.stringify(value, null, 2);
  }
  return String(value);
}

export interface FieldListProps {
  /** [key, value] pairs, shown in order. Keys are humanised for the label. */
  entries: Array<[string, unknown]>;
}

// Labelled read-only list of fields (a <dl>), preserving line breaks in values.
export default function FieldList({ entries }: FieldListProps) {
  if (entries.length === 0) {
    return <p style={{ margin: 0, color: 'var(--c-text-3)' }}>{EMPTY}</p>;
  }
  return (
    <dl
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(140px, max-content) 1fr',
        columnGap: 'var(--sp-4)',
        rowGap: 'var(--sp-2)',
        margin: 0,
        fontSize: 14,
      }}
    >
      {entries.map(([key, value]) => (
        <div key={key} style={{ display: 'contents' }}>
          <dt style={{ color: 'var(--c-text-2)' }}>{humanizeKey(key)}</dt>
          <dd style={{ margin: 0, color: 'var(--c-text)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {formatFieldValue(value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}
