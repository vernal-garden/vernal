import { Link } from 'react-router-dom';
import { MONTH_LONG, MONTH_SHORT, parseDay } from '../../lib/guideDates';
import { formatQuantity } from '../../hooks/useHarvests';
import type { HarvestEntry } from '../../types/harvest';
import { textButtonStyle } from './formStyles';

interface Props {
  entries: HarvestEntry[];
  selectedId: string | null;
  highlightId: string | null;
  listSearch: string;
  isMobile: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}

interface Group {
  key: string;
  label: string;
  entries: HarvestEntry[];
}

// The API returns entries newest first, so groups and their contents already
// read most recent first.
function groupByMonth(entries: HarvestEntry[]): Group[] {
  const groups: Group[] = [];
  for (const e of entries) {
    const { y, m } = parseDay(e.harvestDate);
    const key = `${y}-${m}`;
    let group = groups[groups.length - 1];
    if (!group || group.key !== key) {
      group = { key, label: `${MONTH_LONG[m - 1]} ${y}`, entries: [] };
      groups.push(group);
    }
    group.entries.push(e);
  }
  return groups;
}

function shortDate(key: string): string {
  const { m, d } = parseDay(key);
  return `${MONTH_SHORT[m - 1]} ${d}`;
}

export default function HarvestList({
  entries, selectedId, highlightId, listSearch, isMobile, hasMore, loadingMore, onLoadMore,
}: Props) {
  const groups = groupByMonth(entries);

  return (
    <div style={{ fontFamily: 'var(--font-ui)' }}>
      <style>{`
        @keyframes vernal-harvest-pulse { from { background-color: var(--c-primary-light); } to { background-color: var(--c-surface); } }
        .vernal-harvest-pulse { animation: vernal-harvest-pulse 1s ease-out; }
        @media (prefers-reduced-motion: reduce) { .vernal-harvest-pulse { animation: none; } }
      `}</style>

      {groups.map((group) => (
        <section key={group.key} aria-labelledby={`harvest-month-${group.key}`} data-testid="harvest-month">
          <h2
            id={`harvest-month-${group.key}`}
            style={{
              position: 'sticky',
              top: isMobile ? 'var(--shell-top)' : 0,
              zIndex: 5,
              margin: 0,
              padding: 'var(--sp-2) var(--sp-1)',
              background: 'var(--c-bg)',
              fontSize: 13,
              fontWeight: 600,
              color: 'var(--c-text-3)',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
            }}
          >
            {group.label}
          </h2>
          <ul style={{ listStyle: 'none', margin: '0 0 var(--sp-3)', padding: 0, display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}>
            {group.entries.map((e) => {
              const selected = e.id === selectedId;
              const quantity = formatQuantity(e.quantity, e.unit);
              const where = [e.gardenName, e.bedId ? e.bedLabel?.trim() || 'Unnamed bed' : null].filter(Boolean).join(' · ');
              return (
                <li key={e.id}>
                  <Link
                    to={`/harvest/${e.id}${listSearch}`}
                    aria-current={selected ? 'page' : undefined}
                    data-testid="harvest-card"
                    className={e.id === highlightId ? 'vernal-harvest-pulse' : undefined}
                    style={{
                      minHeight: 44,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 'var(--sp-3)',
                      padding: 'var(--sp-3)',
                      background: selected ? 'var(--c-primary-subtle)' : 'var(--c-surface)',
                      border: `1px solid ${selected ? 'var(--c-primary-light)' : 'var(--c-border-subtle)'}`,
                      borderRadius: 'var(--r-lg)',
                      color: 'var(--c-text)',
                      textDecoration: 'none',
                    }}
                  >
                    {e.photos[0] && (
                      <img
                        src={e.photos[0].url}
                        alt=""
                        style={{ width: 48, height: 48, flexShrink: 0, objectFit: 'cover', borderRadius: 'var(--r-md)' }}
                      />
                    )}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--sp-2)' }}>
                        <span style={{ flex: 1, minWidth: 0, fontSize: 16, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {e.commonName ?? 'Unnamed plant'}
                        </span>
                        <span style={{ flexShrink: 0, fontSize: 13, color: 'var(--c-text-3)' }}>{shortDate(e.harvestDate)}</span>
                      </div>
                      <div style={{ fontSize: 13, color: 'var(--c-text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {where}
                        {quantity && <span style={{ color: 'var(--c-text)', fontWeight: 600 }}>{where ? ' · ' : ''}{quantity}</span>}
                      </div>
                      {e.notes && (
                        <div style={{ fontSize: 13, color: 'var(--c-text-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {e.notes}
                        </div>
                      )}
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      {hasMore && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--sp-3) 0' }}>
          <button type="button" onClick={onLoadMore} disabled={loadingMore} style={{ ...textButtonStyle, opacity: loadingMore ? 0.6 : 1 }}>
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </div>
  );
}
