// client/src/components/catalogue/DataGrid.tsx

export interface DataGridEntry {
  label: string;
  value: string | number | null | undefined;
}

interface Props {
  entries: DataGridEntry[];
}

export default function DataGrid({ entries }: Props) {
  // Keep 0 (valid numeric value e.g. spacing) but drop null, undefined, and empty string.
  const visible = entries.filter(e => e.value !== null && e.value !== undefined && e.value !== '');
  if (visible.length === 0) return null;

  return (
    <dl style={{
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gap: '1px',
      background: 'var(--c-border-subtle)',
      borderRadius: 'var(--r-md)',
      overflow: 'hidden',
      fontSize: 13,
      fontFamily: 'var(--font-ui)',
    }}>
      {visible.map(({ label, value }) => (
        <div key={label} style={{ background: 'var(--c-surface)', padding: 'var(--sp-2) var(--sp-3)' }}>
          <dt style={{ color: 'var(--c-text-3)', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>
            {label}
          </dt>
          <dd style={{ color: 'var(--c-text)', margin: 0, fontWeight: 500 }}>
            {String(value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}
