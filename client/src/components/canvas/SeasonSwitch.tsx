import { useRef } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';
import { useIsMobile } from '../../hooks/useIsMobile';
import { SEASON_THIS, seasonPlan } from '../../lib/planningStrings';

// Phase 76b: the two-option season switch (this season / plan next season),
// shared by CanvasToolbar and MobileCanvasControls. A radio group: arrow keys
// move between the options and select, Tab enters at the checked one.

export type SeasonChoice = 'current' | 'next';

interface Props {
  viewedSeason: number;
  nextSeason: number;
  onChange: (choice: SeasonChoice) => void;
}

const groupStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'stretch',
  flexShrink: 0,
  padding: 2,
  gap: 2,
  background: 'var(--c-surface)',
  border: '1px solid var(--c-border)',
  borderRadius: 'var(--r-md)',
  boxSizing: 'border-box',
  pointerEvents: 'auto',
};

// Each option is a touch target on phones (44px); the desktop toolbar keeps 38.
function optionStyle(checked: boolean, isMobile: boolean): CSSProperties {
  return {
    minHeight: isMobile ? 44 : 38,
    minWidth: 44,
    padding: '0 var(--sp-3)',
    border: 'none',
    borderRadius: 'var(--r-sm)',
    background: checked ? 'var(--c-primary-subtle)' : 'transparent',
    color: checked ? 'var(--c-primary)' : 'var(--c-text-2)',
    fontFamily: 'var(--font-ui)',
    fontSize: 14,
    fontWeight: checked ? 600 : 500,
    whiteSpace: 'nowrap',
    cursor: 'pointer',
  };
}

export default function SeasonSwitch({ viewedSeason, nextSeason, onChange }: Props) {
  const current: SeasonChoice = viewedSeason === nextSeason ? 'next' : 'current';
  const isMobile = useIsMobile();
  const refs = useRef<Record<SeasonChoice, HTMLButtonElement | null>>({ current: null, next: null });

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    // Two options: any arrow moves to the other one.
    const target: SeasonChoice = current === 'current' ? 'next' : 'current';
    onChange(target);
    refs.current[target]?.focus();
  };

  const option = (choice: SeasonChoice, label: string) => {
    const checked = current === choice;
    return (
      <button
        ref={el => { refs.current[choice] = el; }}
        type="button"
        role="radio"
        aria-checked={checked}
        tabIndex={checked ? 0 : -1}
        onClick={() => { if (!checked) onChange(choice); }}
        onKeyDown={onKeyDown}
        style={optionStyle(checked, isMobile)}
      >
        {label}
      </button>
    );
  };

  return (
    <div role="radiogroup" aria-label="Season" style={groupStyle}>
      {option('current', SEASON_THIS)}
      {option('next', seasonPlan(nextSeason))}
    </div>
  );
}
