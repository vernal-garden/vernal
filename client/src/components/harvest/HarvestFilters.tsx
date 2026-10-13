import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import type { GardenSummary } from '../../hooks/useGardenList';
import { seedParamOf } from '../../hooks/useHarvests';
import type { Chip, HarvestFilters, RangeKind } from '../../lib/harvestFilters';
import type { PlantOption } from '../../types/harvest';
import { CloseIcon } from '../shell/icons';
import PlantSearch from './PlantSearch';
import { inputStyle, labelStyle, textLinkButtonStyle } from './formStyles';

const SEARCH_DEBOUNCE_MS = 300;

interface Props {
  filters: HarvestFilters;
  onChange: (next: HarvestFilters) => void;
  gardens: GardenSummary[];
  seasonOptions: number[];
  // 'bar' lays the controls out inline (desktop); 'stack' stacks them (mobile sheet).
  layout: 'bar' | 'stack';
  onPlantChosen: (option: PlantOption) => void;
}

export function HarvestFilterControls({ filters, onChange, gardens, seasonOptions, layout, onPlantChosen }: Props) {
  const uid = useId();
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  // The search box keeps its own text and writes q 300ms after typing stops.
  const [search, setSearch] = useState(filters.q ?? '');
  const lastWritten = useRef(filters.q ?? '');
  useEffect(() => {
    // An outside change (a removed chip, Clear all) resets the box.
    if ((filters.q ?? '') !== lastWritten.current) {
      lastWritten.current = filters.q ?? '';
      setSearch(filters.q ?? '');
    }
  }, [filters.q]);
  useEffect(() => {
    const trimmed = search.trim();
    if (trimmed === (filtersRef.current.q ?? '')) return;
    const timer = window.setTimeout(() => {
      lastWritten.current = trimmed;
      onChange({ ...filtersRef.current, q: trimmed || null });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [search, onChange]);

  const stacked = layout === 'stack';
  const item = (width: number | string): CSSProperties => (stacked ? { marginBottom: 'var(--sp-4)' } : { width, flex: '0 0 auto' });

  return (
    <div
      style={
        stacked
          ? { fontFamily: 'var(--font-ui)' }
          : { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 'var(--sp-3)', fontFamily: 'var(--font-ui)' }
      }
    >
      <div style={item(220)}>
        <label htmlFor={`${uid}-q`} style={labelStyle}>Search</label>
        <input
          id={`${uid}-q`}
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Plant or note"
          style={inputStyle}
        />
      </div>

      <div style={item(150)}>
        <label htmlFor={`${uid}-season`} style={labelStyle}>Season</label>
        <select
          id={`${uid}-season`}
          value={String(filters.season)}
          onChange={(e) => onChange({ ...filters, season: e.target.value === 'all' ? 'all' : Number(e.target.value) })}
          style={inputStyle}
        >
          <option value="all">All seasons</option>
          {seasonOptions.map((y) => (
            <option key={y} value={y}>{y}</option>
          ))}
        </select>
      </div>

      {gardens.length > 1 && (
        <div style={item(180)}>
          <label htmlFor={`${uid}-garden`} style={labelStyle}>Garden</label>
          <select
            id={`${uid}-garden`}
            value={filters.gardenId ?? ''}
            onChange={(e) => onChange({ ...filters, gardenId: e.target.value || null })}
            style={inputStyle}
          >
            <option value="">All gardens</option>
            {gardens.map((g) => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </select>
        </div>
      )}

      <div style={item(220)}>
        <span style={labelStyle}>Plants</span>
        <PlantSearch
          variant="combobox"
          label="Filter by plant"
          placeholder="Add a plant"
          exclude={filters.seeds}
          onSelect={(o) => {
            onPlantChosen(o);
            const s = seedParamOf(o);
            if (!filtersRef.current.seeds.includes(s)) onChange({ ...filtersRef.current, seeds: [...filtersRef.current.seeds, s] });
          }}
        />
      </div>

      <div style={item(170)}>
        <label htmlFor={`${uid}-range`} style={labelStyle}>Dates</label>
        <select
          id={`${uid}-range`}
          value={filters.range}
          onChange={(e) => {
            const range = e.target.value as RangeKind;
            onChange({ ...filters, range, from: range === 'custom' ? filters.from : null, to: range === 'custom' ? filters.to : null });
          }}
          style={inputStyle}
        >
          <option value="all">Any date</option>
          <option value="month">This month</option>
          <option value="3m">Last 3 months</option>
          <option value="custom">Custom…</option>
        </select>
      </div>

      {filters.range === 'custom' && (
        <>
          <div style={item(160)}>
            <label htmlFor={`${uid}-from`} style={labelStyle}>From</label>
            <input
              id={`${uid}-from`}
              type="date"
              value={filters.from ?? ''}
              max={filters.to ?? undefined}
              onChange={(e) => onChange({ ...filters, from: e.target.value || null })}
              style={inputStyle}
            />
          </div>
          <div style={item(160)}>
            <label htmlFor={`${uid}-to`} style={labelStyle}>To</label>
            <input
              id={`${uid}-to`}
              type="date"
              value={filters.to ?? ''}
              min={filters.from ?? undefined}
              onChange={(e) => onChange({ ...filters, to: e.target.value || null })}
              style={inputStyle}
            />
          </div>
        </>
      )}
    </div>
  );
}

interface ChipsProps {
  chips: Chip[];
  filters: HarvestFilters;
  onChange: (next: HarvestFilters) => void;
  onClearAll: () => void;
  scroll: boolean;
}

// One chip per filter not at its default, plus "Clear all" when any is active.
export function FilterChips({ chips, filters, onChange, onClearAll, scroll }: ChipsProps) {
  if (chips.length === 0) return null;
  return (
    <div
      role="list"
      aria-label="Active filters"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--sp-2)',
        flexWrap: scroll ? 'nowrap' : 'wrap',
        overflowX: scroll ? 'auto' : undefined,
        fontFamily: 'var(--font-ui)',
        paddingBottom: scroll ? 'var(--sp-1)' : undefined,
      }}
    >
      {chips.map((chip) => (
        <span
          key={chip.key}
          role="listitem"
          style={{
            flexShrink: 0,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 2,
            paddingLeft: 'var(--sp-3)',
            background: 'var(--c-primary-subtle)',
            color: 'var(--c-primary-dark)',
            border: '1px solid var(--c-primary-light)',
            borderRadius: 'var(--r-full)',
            fontSize: 13,
            fontWeight: 600,
            whiteSpace: 'nowrap',
          }}
        >
          {chip.label}
          <button
            type="button"
            aria-label={`Remove ${chip.label}`}
            onClick={() => onChange(chip.remove(filters))}
            style={{
              width: 44,
              height: 44,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 0,
              border: 'none',
              background: 'transparent',
              color: 'inherit',
              cursor: 'pointer',
              borderRadius: 'var(--r-full)',
            }}
          >
            <CloseIcon width={16} height={16} />
          </button>
        </span>
      ))}
      <button type="button" onClick={onClearAll} style={{ ...textLinkButtonStyle, flexShrink: 0 }}>
        Clear all
      </button>
    </div>
  );
}
