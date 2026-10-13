import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type Ref } from 'react';
import { fetchPlantOptions, seedParamOf } from '../../hooks/useHarvests';
import type { PlantOption, PlantOptionSource } from '../../types/harvest';
import { inputStyle } from './formStyles';

// Plant search over GET /api/harvests/plant-options (debounced 250ms).
// variant 'combobox': an input with a popup listbox (desktop).
// variant 'list': a search input with the list always shown (mobile sheet).

const DEBOUNCE_MS = 250;

export const SOURCE_HINT: Record<PlantOptionSource, string> = {
  planted: 'In your garden',
  personal: 'Your seed',
  cambium: 'Community',
};

interface Props {
  variant: 'combobox' | 'list';
  label: string;
  onSelect: (option: PlantOption) => void;
  inputRef?: Ref<HTMLInputElement>;
  invalid?: boolean;
  describedBy?: string;
  placeholder?: string;
  // Options to leave out (already chosen), by seed param.
  exclude?: string[];
  autoFocus?: boolean;
}

export default function PlantSearch({
  variant, label, onSelect, inputRef, invalid, describedBy, placeholder, exclude = [], autoFocus,
}: Props) {
  const listId = useId();
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<PlantOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(variant === 'list');
  const [activeIndex, setActiveIndex] = useState(-1);
  const requestId = useRef(0);

  const shouldFetch = variant === 'list' || open;

  useEffect(() => {
    if (!shouldFetch) return;
    const id = ++requestId.current;
    const timer = window.setTimeout(() => {
      setLoading(true);
      setFailed(false);
      fetchPlantOptions(query.trim())
        .then((rows) => {
          if (id === requestId.current) setOptions(rows);
        })
        .catch(() => {
          if (id === requestId.current) setFailed(true);
        })
        .finally(() => {
          if (id === requestId.current) setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query, shouldFetch]);

  const visible = options.filter((o) => !exclude.includes(seedParamOf(o)));
  const showList = variant === 'list' || open;

  function choose(option: PlantOption) {
    onSelect(option);
    setQuery('');
    setActiveIndex(-1);
    if (variant === 'combobox') setOpen(false);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActiveIndex((i) => Math.min(visible.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      if (showList && activeIndex >= 0 && visible[activeIndex]) {
        e.preventDefault();
        choose(visible[activeIndex]);
      }
    } else if (e.key === 'Escape' && variant === 'combobox' && open) {
      e.stopPropagation();
      setOpen(false);
    }
  }

  const optionId = (i: number) => `${listId}-opt-${i}`;

  return (
    <div style={{ position: 'relative' }}>
      <input
        ref={inputRef}
        type="text"
        role={variant === 'combobox' ? 'combobox' : 'searchbox'}
        aria-label={label}
        aria-expanded={variant === 'combobox' ? showList : undefined}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeIndex >= 0 && visible[activeIndex] ? optionId(activeIndex) : undefined}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        autoComplete="off"
        autoFocus={autoFocus}
        placeholder={placeholder ?? 'Search your plants'}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setActiveIndex(-1);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          // Let a click on an option land before closing.
          if (variant === 'combobox') window.setTimeout(() => setOpen(false), 150);
        }}
        onKeyDown={onKeyDown}
        style={{ ...inputStyle, borderColor: invalid ? 'var(--c-danger)' : 'var(--c-border)' }}
      />

      {showList && (
        <ul
          id={listId}
          role="listbox"
          aria-label={`${label} options`}
          style={variant === 'combobox' ? popupStyle : listStyle}
        >
          {visible.map((o, i) => (
            <li
              key={seedParamOf(o)}
              id={optionId(i)}
              role="option"
              aria-selected={i === activeIndex}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(o)}
              style={{
                minHeight: 44,
                padding: 'var(--sp-2) var(--sp-3)',
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--sp-3)',
                cursor: 'pointer',
                background: i === activeIndex ? 'var(--c-primary-subtle)' : 'transparent',
                borderBottom: '1px solid var(--c-border-subtle)',
              }}
            >
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 14, fontWeight: 600, color: 'var(--c-text)' }}>
                  {o.commonName ?? 'Unnamed plant'}
                </span>
                {o.scientificName && (
                  <span style={{ display: 'block', fontSize: 12, fontStyle: 'italic', color: 'var(--c-text-3)' }}>
                    {o.scientificName}
                  </span>
                )}
              </span>
              <span style={{ fontSize: 12, color: 'var(--c-text-3)', whiteSpace: 'nowrap' }}>{SOURCE_HINT[o.source]}</span>
            </li>
          ))}
          {!loading && !failed && visible.length === 0 && (
            <li role="presentation" style={emptyRowStyle}>
              {query.trim().length < 2 ? 'Type to search the community catalogue too.' : 'No plants match.'}
            </li>
          )}
          {failed && (
            <li role="presentation" style={{ ...emptyRowStyle, color: 'var(--c-danger)' }}>
              Couldn&rsquo;t load plants.
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

const listStyle: CSSProperties = {
  listStyle: 'none',
  margin: 'var(--sp-2) 0 0',
  padding: 0,
  fontFamily: 'var(--font-ui)',
};

const popupStyle: CSSProperties = {
  ...listStyle,
  position: 'absolute',
  top: '100%',
  left: 0,
  right: 0,
  zIndex: 10,
  margin: 'var(--sp-1) 0 0',
  maxHeight: 280,
  overflowY: 'auto',
  background: 'var(--c-surface)',
  border: '1px solid var(--c-border)',
  borderRadius: 'var(--r-md)',
  boxShadow: 'var(--shadow-md)',
};

const emptyRowStyle: CSSProperties = {
  padding: 'var(--sp-3)',
  fontSize: 13,
  color: 'var(--c-text-3)',
};
