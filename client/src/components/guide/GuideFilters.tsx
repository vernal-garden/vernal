import { useState } from 'react';
import type { GuideGarden } from '../../types/plantingGuide';
import type { GuideFilterState } from '../../lib/guideModel';
import BottomSheet from '../shell/BottomSheet';
import { segmentGroupStyle, segmentStyle, textButtonStyle } from './styles';

interface Props {
  filters: GuideFilterState;
  onChange: (filters: GuideFilterState) => void;
  gardens: GuideGarden[];
  isMobile: boolean;
}

const SOW_TYPES: { value: GuideFilterState['sowType']; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'indoors', label: 'Indoors' },
  { value: 'direct', label: 'Direct' },
];

function Controls({ filters, onChange, gardens, stacked }: Omit<Props, 'isMobile'> & { stacked: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: stacked ? 'column' : 'row',
        flexWrap: 'wrap',
        alignItems: stacked ? 'stretch' : 'center',
        gap: 'var(--sp-3)',
        fontFamily: 'var(--font-ui)',
        fontSize: 14,
        color: 'var(--c-text-2)',
      }}
    >
      {gardens.length > 1 && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)' }}>
          Garden
          <select
            value={filters.gardenId}
            onChange={(e) => onChange({ ...filters, gardenId: e.target.value })}
            style={{
              minHeight: 44,
              padding: '0 var(--sp-3)',
              fontFamily: 'var(--font-ui)',
              fontSize: 14,
              color: 'var(--c-text)',
              background: 'var(--c-surface)',
              border: '1px solid var(--c-border)',
              borderRadius: 'var(--r-md)',
              flex: stacked ? 1 : undefined,
            }}
          >
            <option value="all">All gardens</option>
            {gardens.map((g) => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </select>
        </label>
      )}
      <div role="group" aria-label="Sowing type" style={segmentGroupStyle}>
        {SOW_TYPES.map((t) => (
          <button
            key={t.value}
            type="button"
            aria-pressed={filters.sowType === t.value}
            onClick={() => onChange({ ...filters, sowType: t.value })}
            style={{ ...segmentStyle(filters.sowType === t.value), flex: stacked ? 1 : undefined }}
          >
            {t.label}
          </button>
        ))}
      </div>
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--sp-2)', minHeight: 44, cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={filters.dueThisMonth}
          onChange={(e) => onChange({ ...filters, dueThisMonth: e.target.checked })}
          style={{ width: 20, height: 20, accentColor: 'var(--c-primary)' }}
        />
        Due this month
      </label>
    </div>
  );
}

export default function GuideFilters({ filters, onChange, gardens, isMobile }: Props) {
  const [sheetOpen, setSheetOpen] = useState(false);

  if (!isMobile) return <Controls filters={filters} onChange={onChange} gardens={gardens} stacked={false} />;

  const activeCount =
    (filters.gardenId !== 'all' ? 1 : 0) + (filters.sowType !== 'all' ? 1 : 0) + (filters.dueThisMonth ? 1 : 0);

  return (
    <>
      <button type="button" onClick={() => setSheetOpen(true)} style={textButtonStyle}>
        Filter{activeCount > 0 ? ` (${activeCount})` : ''}
      </button>
      <BottomSheet open={sheetOpen} onClose={() => setSheetOpen(false)} title="Filters">
        <div style={{ padding: 'var(--sp-4)' }}>
          <Controls filters={filters} onChange={onChange} gardens={gardens} stacked />
        </div>
      </BottomSheet>
    </>
  );
}
