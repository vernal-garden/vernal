import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { ComparablePlant } from '../../types/metrics';
import { inputStyle, labelStyle } from '../harvest/formStyles';
import { plantKeyOf, plantName } from './styles';

// The "Compare a plant." combobox over the comparable plants (an input with a
// popup listbox). Typing narrows the list by common or scientific name.
// Keyboard: ArrowDown / ArrowUp move, Enter chooses, Escape closes the list and
// restores the chosen plant's name in the input.

interface Props {
  plants: ComparablePlant[];
  // The chosen plant key (seed:<id> | cambium:<id>), or null.
  value: string | null;
  // Shown in the input when the chosen plant isn't in `plants` (e.g. from the URL).
  fallbackName?: string | null;
  onChange: (key: string) => void;
}

export default function ComparePlantPicker({ plants, value, fallbackName, onChange }: Props) {
  const inputId = useId();
  const listId = useId();
  const selected = value === null ? undefined : plants.find((p) => plantKeyOf(p) === value);
  const selectedName = selected ? plantName(selected.commonName) : (fallbackName ?? '');

  const [query, setQuery] = useState(selectedName);
  // True once the user has typed since the list opened: only then filter.
  const [filtering, setFiltering] = useState(false);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const blurTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (blurTimer.current !== null) window.clearTimeout(blurTimer.current);
    },
    [],
  );

  // Keep the active option visible while arrowing through a long list.
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    document.getElementById(`${listId}-opt-${activeIndex}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex, listId]);

  // Keep the input in step with the chosen plant while the list is closed.
  useEffect(() => {
    if (!open) setQuery(selectedName);
  }, [selectedName, open]);

  const needle = query.trim().toLowerCase();
  const visible = !filtering || needle === ''
    ? plants
    : plants.filter(
        (p) =>
          (p.commonName ?? '').toLowerCase().includes(needle) ||
          (p.scientificName ?? '').toLowerCase().includes(needle),
      );

  function choose(p: ComparablePlant) {
    const key = plantKeyOf(p);
    setOpen(false);
    setFiltering(false);
    setActiveIndex(-1);
    setQuery(plantName(p.commonName));
    if (key !== null && key !== value) onChange(key);
  }

  function close() {
    setOpen(false);
    setFiltering(false);
    setActiveIndex(-1);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        setActiveIndex(0);
      } else {
        setActiveIndex((i) => Math.min(visible.length - 1, i + 1));
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (open) setActiveIndex((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      if (open && activeIndex >= 0 && visible[activeIndex]) {
        e.preventDefault();
        choose(visible[activeIndex]);
      }
    } else if (e.key === 'Escape') {
      if (open) {
        e.stopPropagation();
        close();
      } else {
        setQuery(selectedName);
      }
    }
  }

  const optionId = (i: number) => `${listId}-opt-${i}`;

  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 'var(--sp-1)' }}>
      <label htmlFor={inputId} style={labelStyle}>Compare a plant.</label>
      <input
        id={inputId}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && activeIndex >= 0 && visible[activeIndex] ? optionId(activeIndex) : undefined}
        autoComplete="off"
        // ED: replace with final copy
        placeholder="Search your plants"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setFiltering(true);
          setOpen(true);
          setActiveIndex(-1);
        }}
        onFocus={(e) => {
          e.target.select();
          setOpen(true);
        }}
        onBlur={() => {
          // Let a click on an option land before closing.
          if (blurTimer.current !== null) window.clearTimeout(blurTimer.current);
          blurTimer.current = window.setTimeout(() => {
            blurTimer.current = null;
            close();
          }, 150);
        }}
        onKeyDown={onKeyDown}
        style={inputStyle}
      />

      {open && (
        <ul id={listId} role="listbox"
          // ED: replace with final copy
          aria-label="Plants with two or more seasons"
          // Dragging the scrollbar mustn't blur the input and close the list.
          onMouseDown={(e) => e.preventDefault()}
          style={popupStyle}
        >
          {visible.map((p, i) => {
            const key = plantKeyOf(p) ?? `${p.commonName}-${i}`;
            return (
              <li
                key={key}
                id={optionId(i)}
                role="option"
                aria-selected={key === value}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(p)}
                style={{
                  minHeight: 44,
                  padding: 'var(--sp-2) var(--sp-3)',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'center',
                  cursor: 'pointer',
                  background: i === activeIndex ? 'var(--c-primary-subtle)' : 'transparent',
                  borderBottom: '1px solid var(--c-border-subtle)',
                  boxSizing: 'border-box',
                }}
              >
                <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--c-text)' }}>
                  {plantName(p.commonName)}
                  {/* ED: replace with final copy */}
                  {key === value && <span style={{ fontWeight: 400, color: 'var(--c-text-3)' }}> (chosen)</span>}
                </span>
                {p.scientificName && (
                  <span style={{ fontSize: 12, fontStyle: 'italic', color: 'var(--c-text-3)' }}>{p.scientificName}</span>
                )}
              </li>
            );
          })}
          {visible.length === 0 && (
            <li role="presentation" style={{ padding: 'var(--sp-3)', fontSize: 13, color: 'var(--c-text-3)' }}>
              {/* ED: replace with final copy */}
              No plants match.
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

const popupStyle: CSSProperties = {
  listStyle: 'none',
  position: 'absolute',
  top: '100%',
  left: 0,
  right: 0,
  zIndex: 10,
  margin: 'var(--sp-1) 0 0',
  padding: 0,
  maxHeight: 280,
  overflowY: 'auto',
  background: 'var(--c-surface)',
  border: '1px solid var(--c-border)',
  borderRadius: 'var(--r-md)',
  boxShadow: 'var(--shadow-md)',
  fontFamily: 'var(--font-ui)',
};
