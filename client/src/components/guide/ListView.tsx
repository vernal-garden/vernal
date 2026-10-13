import { useState, type CSSProperties } from 'react';
import type { GuideRow, GuideWindow, WindowKind } from '../../types/plantingGuide';
import { formatRange, MONTH_LONG, monthStart, parseDay } from '../../lib/guideDates';
import { hasWindows, isDone, rowKey, rowName, rowWindows, sowingKind, WINDOW_KINDS } from '../../lib/guideModel';
import RowLabel from './RowLabel';
import { segmentGroupStyle, segmentStyle, tagStyle, textButtonStyle } from './styles';
import { gardenOf, type GuideViewProps } from './viewTypes';

const ITEM_NAMES: Record<WindowKind, string> = {
  indoorStart: 'Start indoors',
  transplant: 'Transplant out',
  directSow: 'Direct sow',
  harvest: 'Harvest window opens',
};

type Grouping = 'time' | 'plant' | 'garden';

interface Item {
  row: GuideRow;
  kind: WindowKind;
  window: GuideWindow;
}

interface Group {
  key: string;
  title: string;
  items: Item[];
}

interface Props extends GuideViewProps {
  readOnly: boolean;
  onToggleDone: (row: GuideRow, done: boolean) => void;
}

const byKindThenName = (a: Item, b: Item) =>
  WINDOW_KINDS.indexOf(a.kind) - WINDOW_KINDS.indexOf(b.kind) || rowName(a.row).localeCompare(rowName(b.row));

const byStartThenKind = (a: Item, b: Item) =>
  a.window.start.localeCompare(b.window.start) || byKindThenName(a, b);

function groupByTime(items: Item[], today: string, season: number): Group[] {
  const now = parseDay(today);
  const thisMonth = monthStart(now.y, now.m);
  const nextMonth = now.m === 12 ? monthStart(now.y + 1, 1) : monthStart(now.y, now.m + 1);
  const groups = new Map<string, Group>();
  for (const item of items) {
    const { y, m } = parseDay(item.window.start);
    const itemMonth = monthStart(y, m);
    let key: string;
    let title: string;
    if (itemMonth < thisMonth) {
      key = '0000-00';
      title = 'Earlier';
    } else if (itemMonth === thisMonth) {
      key = itemMonth;
      title = 'This month';
    } else if (itemMonth === nextMonth) {
      key = itemMonth;
      title = 'Next month';
    } else {
      key = itemMonth;
      title = y === season ? MONTH_LONG[m - 1] : `${MONTH_LONG[m - 1]} ${y}`;
    }
    if (!groups.has(key)) groups.set(key, { key, title, items: [] });
    groups.get(key)!.items.push(item);
  }
  return [...groups.values()]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((g) => ({ ...g, items: g.items.sort(byKindThenName) }));
}

function groupBy(items: Item[], keyOf: (item: Item) => { key: string; title: string }, sort: (a: Item, b: Item) => number): Group[] {
  const groups = new Map<string, Group>();
  for (const item of items) {
    const { key, title } = keyOf(item);
    if (!groups.has(key)) groups.set(key, { key, title, items: [] });
    groups.get(key)!.items.push(item);
  }
  return [...groups.values()].map((g) => ({ ...g, items: g.items.sort(sort) }));
}

export default function ListView(props: Props) {
  const { rows, gardens, season, today, showGardenName, readOnly, onOpen, onToggleDone } = props;
  const [grouping, setGrouping] = useState<Grouping>('time');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const items: Item[] = rows.flatMap((row) => rowWindows(row).map(({ kind, window }) => ({ row, kind, window })));
  const noDates = rows.filter((row) => !hasWindows(row));
  const gardenName = (row: GuideRow) => gardenOf(gardens, row)?.name ?? '';

  let groups: Group[];
  if (grouping === 'time') {
    groups = groupByTime(items, today, season);
  } else if (grouping === 'plant') {
    groups = groupBy(
      items,
      (i) => ({ key: rowKey(i.row), title: showGardenName ? `${rowName(i.row)} · ${gardenName(i.row)}` : rowName(i.row) }),
      byStartThenKind,
    );
  } else {
    groups = groupBy(items, (i) => ({ key: i.row.gardenId, title: gardenName(i.row) }), byStartThenKind);
  }

  function toggle(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const groupingControl = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)', flexWrap: 'wrap', marginBottom: 'var(--sp-3)' }}>
      <span style={{ fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--c-text-3)' }}>Group</span>
      <div role="group" aria-label="Group by" style={segmentGroupStyle}>
        {([
          ['time', 'By time'],
          ['plant', 'By plant'],
          ['garden', 'By garden'],
        ] as const).map(([value, label]) => (
          <button key={value} type="button" aria-pressed={grouping === value} onClick={() => setGrouping(value)} style={segmentStyle(grouping === value)}>
            {label}
          </button>
        ))}
      </div>
    </div>
  );

  if (groups.length === 0 && noDates.length === 0) {
    return (
      <div>
        {groupingControl}
        <p style={{ fontFamily: 'var(--font-ui)', fontSize: 14, color: 'var(--c-text-3)' }}>
          No plants to show for the current filters.
        </p>
      </div>
    );
  }

  const header = (key: string, title: string, count: number) => (
    <button
      type="button"
      aria-expanded={!collapsed.has(key)}
      onClick={() => toggle(key)}
      style={{
        width: '100%',
        minHeight: 44,
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--sp-2)',
        padding: '0 var(--sp-1)',
        background: 'transparent',
        border: 'none',
        borderBottom: '1px solid var(--c-border)',
        cursor: 'pointer',
        fontFamily: 'var(--font-display)',
        fontSize: 17,
        fontWeight: 600,
        color: 'var(--c-text)',
        textAlign: 'left',
      }}
    >
      <span aria-hidden="true" style={{ width: 16, color: 'var(--c-text-3)' }}>{collapsed.has(key) ? '▸' : '▾'}</span>
      <span style={{ flex: 1 }}>{title}</span>
      <span style={{ fontFamily: 'var(--font-ui)', fontSize: 12, fontWeight: 400, color: 'var(--c-text-3)' }}>{count}</span>
    </button>
  );

  return (
    <div>
      {groupingControl}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)' }}>
        {groups.map((group) => (
          <section key={group.key} aria-label={group.title}>
            {header(group.key, group.title, group.items.length)}
            {!collapsed.has(group.key) && (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {group.items.map((item) => (
                  <ListItem
                    key={`${rowKey(item.row)}-${item.kind}`}
                    item={item}
                    gardenName={showGardenName ? gardenName(item.row) : null}
                    readOnly={readOnly}
                    onOpen={onOpen}
                    onToggleDone={onToggleDone}
                  />
                ))}
              </ul>
            )}
          </section>
        ))}

        {noDates.length > 0 && (
          <section aria-label="No dates yet">
            {header('no-dates', 'No dates yet', noDates.length)}
            {!collapsed.has('no-dates') && (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {noDates.map((row) => (
                  <li
                    key={rowKey(row)}
                    style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-3)', padding: 'var(--sp-2) 0', borderBottom: '1px solid var(--c-border-subtle)' }}
                  >
                    <button type="button" onClick={() => onOpen(row)} style={rowButtonStyle}>
                      <RowLabel row={row} gardenName={showGardenName ? gardenName(row) : null} />
                    </button>
                    <button type="button" onClick={() => onOpen(row)} style={textButtonStyle}>
                      Add dates
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

const rowButtonStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  minHeight: 44,
  padding: 0,
  display: 'flex',
  alignItems: 'center',
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
};

interface ItemProps {
  item: Item;
  gardenName: string | null;
  readOnly: boolean;
  onOpen: (row: GuideRow) => void;
  onToggleDone: (row: GuideRow, done: boolean) => void;
}

function ListItem({ item, gardenName, readOnly, onOpen, onToggleDone }: ItemProps) {
  const { row, kind, window } = item;
  const done = isDone(row);
  const isSowing = sowingKind(row) === kind;
  const name = rowName(row);
  return (
    <li
      data-testid="guide-list-item"
      style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-3)', padding: 'var(--sp-2) 0', borderBottom: '1px solid var(--c-border-subtle)' }}
    >
      {isSowing ? (
        <label
          style={{ width: 44, height: 44, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: readOnly ? 'default' : 'pointer' }}
        >
          <input
            type="checkbox"
            aria-label={`${name}: ${ITEM_NAMES[kind]} done`}
            checked={done}
            disabled={readOnly}
            onChange={(e) => onToggleDone(row, e.target.checked)}
            style={{ width: 20, height: 20, accentColor: 'var(--c-primary)' }}
          />
        </label>
      ) : (
        <span style={{ width: 44, flexShrink: 0 }} />
      )}
      <button type="button" onClick={() => onOpen(row)} style={rowButtonStyle}>
        <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
          <span style={{ fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 600, color: 'var(--c-text-2)', textAlign: 'left' }}>
            {ITEM_NAMES[kind]} · {formatRange(window.start, window.end)}
          </span>
          <RowLabel row={row} gardenName={gardenName} compact />
        </span>
      </button>
      {done && !isSowing && <span style={{ ...tagStyle, color: 'var(--c-text-3)' }}>Done</span>}
    </li>
  );
}
