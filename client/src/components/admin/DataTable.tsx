import { type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';

export type SortDirection = 'asc' | 'desc';

export interface DataTableColumn<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  sortable?: boolean;
  align?: 'left' | 'right';
  width?: number | string;
  /** Direction used when this column is first clicked (default 'asc'). */
  defaultDir?: SortDirection;
  /** Tooltip for the (possibly truncated) cell. Defaults to the rendered value when it is a string/number. */
  title?: (row: T) => string;
}

export interface DataTableProps<T> {
  columns: Array<DataTableColumn<T>>;
  rows: T[];
  rowKey: (row: T) => string | number;
  sort?: { key: string; dir: SortDirection };
  onSortChange?: (key: string, dir: SortDirection) => void;
  onRowClick?: (row: T) => void;
  emptyText: string;
  loading?: boolean;
  /** Highlights the row with this key (e.g. the open item in a two-panel view). */
  selectedKey?: string | number | null;
}

const INTERACTIVE = 'button, a, input, label, select, textarea';

export default function DataTable<T>({
  columns,
  rows,
  rowKey,
  sort,
  onSortChange,
  onRowClick,
  emptyText,
  loading,
  selectedKey,
}: DataTableProps<T>) {
  function headerClick(col: DataTableColumn<T>) {
    if (!onSortChange) return;
    if (sort?.key === col.key) onSortChange(col.key, sort.dir === 'asc' ? 'desc' : 'asc');
    else onSortChange(col.key, col.defaultDir ?? 'asc');
  }

  function fromInteractive(target: EventTarget, row: HTMLElement): boolean {
    const hit = (target as HTMLElement).closest?.(INTERACTIVE);
    return !!hit && hit !== row && row.contains(hit);
  }

  function rowClick(e: MouseEvent<HTMLTableRowElement>, row: T) {
    if (!onRowClick || fromInteractive(e.target, e.currentTarget)) return;
    onRowClick(row);
  }

  function rowKeyDown(e: KeyboardEvent<HTMLTableRowElement>, row: T) {
    if (!onRowClick || (e.key !== 'Enter' && e.key !== ' ') || e.target !== e.currentTarget) return;
    e.preventDefault();
    onRowClick(row);
  }

  const cell = (align?: 'left' | 'right') => ({
    padding: '0 var(--sp-3)',
    textAlign: align ?? 'left',
    whiteSpace: 'nowrap' as const,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  });

  return (
    <table
      aria-busy={loading || undefined}
      style={{
        width: '100%',
        borderCollapse: 'collapse',
        tableLayout: 'fixed',
        fontFamily: 'var(--font-ui)',
        fontSize: 14,
        color: 'var(--c-text)',
        opacity: loading ? 0.6 : 1,
      }}
    >
      <thead>
        <tr style={{ height: 36, borderBottom: '1px solid var(--c-border)' }}>
          {columns.map((col) => {
            const active = sort?.key === col.key;
            const ariaSort = col.sortable
              ? active
                ? sort!.dir === 'asc'
                  ? 'ascending'
                  : 'descending'
                : 'none'
              : undefined;
            return (
              <th
                key={col.key}
                scope="col"
                aria-sort={ariaSort}
                style={{
                  ...cell(col.align),
                  width: col.width,
                  fontSize: 12,
                  fontWeight: 600,
                  color: 'var(--c-text-2)',
                }}
              >
                {col.sortable && onSortChange ? (
                  <button
                    type="button"
                    onClick={() => headerClick(col)}
                    style={{
                      background: 'none',
                      border: 'none',
                      padding: 0,
                      font: 'inherit',
                      color: active ? 'var(--c-text)' : 'inherit',
                      cursor: 'pointer',
                    }}
                  >
                    {col.header}
                    {active && <span aria-hidden="true">{sort!.dir === 'asc' ? ' ▲' : ' ▼'}</span>}
                  </button>
                ) : (
                  col.header
                )}
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr>
            <td colSpan={columns.length} style={{ padding: 'var(--sp-4) var(--sp-3)', color: 'var(--c-text-3)' }}>
              {loading ? 'Loading…' : emptyText}
            </td>
          </tr>
        ) : (
          rows.map((row) => {
            const key = rowKey(row);
            const clickable = !!onRowClick;
            const selected = selectedKey != null && selectedKey === key;
            return (
              <tr
                key={key}
                tabIndex={clickable ? 0 : undefined}
                aria-current={selected ? 'true' : undefined}
                className={clickable ? 'hover:bg-[var(--c-surface-raised)]' : undefined}
                onClick={clickable ? (e) => rowClick(e, row) : undefined}
                onKeyDown={clickable ? (e) => rowKeyDown(e, row) : undefined}
                style={{
                  height: 36,
                  borderBottom: '1px solid var(--c-border-subtle)',
                  background: selected ? 'var(--c-surface-raised)' : undefined,
                  cursor: clickable ? 'pointer' : undefined,
                }}
              >
                {columns.map((col) => {
                  const content = col.render(row);
                  const title = col.title
                    ? col.title(row)
                    : typeof content === 'string' || typeof content === 'number'
                      ? String(content)
                      : undefined;
                  return (
                    <td key={col.key} title={title} style={cell(col.align)}>
                      {content}
                    </td>
                  );
                })}
              </tr>
            );
          })
        )}
      </tbody>
    </table>
  );
}
