import { useState } from 'react';
import type { GuideGarden } from '../../types/plantingGuide';
import { daysBetween, formatAround } from '../../lib/guideDates';
import { CloseIcon } from '../shell/icons';
import { iconButtonStyle } from './styles';

const LEAD_DAYS = 42;

interface Props {
  garden: GuideGarden;
  season: number;
  today: string;
}

function readDismissed(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function within(today: string, target: string | null): target is string {
  if (!target) return false;
  const days = daysBetween(today, target);
  return days >= 0 && days <= LEAD_DAYS;
}

// Amber reminder in the six weeks before the garden's last spring frost or
// first fall frost.
export default function FrostBanner({ garden, season, today }: Props) {
  const { lastSpringFrost, firstFallFrost, frostSource } = garden.frost;
  const estimated = frostSource === 'zone_estimate';

  let which: 'spring' | 'fall' | null = null;
  let message = '';
  if (within(today, lastSpringFrost)) {
    which = 'spring';
    message = `Last spring frost for Zone ${garden.zone}: ${formatAround(lastSpringFrost, estimated)}. Indoor starts due soon.`;
  } else if (within(today, firstFallFrost)) {
    which = 'fall';
    message = `First fall frost for Zone ${garden.zone}: ${formatAround(firstFallFrost, estimated)}.`;
  }

  const key = `vernal.guide.frost.${season}.${which}.${garden.id}`;
  const [dismissedKeys, setDismissedKeys] = useState<string[]>([]);

  if (!which || dismissedKeys.includes(key) || readDismissed(key)) return null;

  function dismiss() {
    try {
      window.localStorage.setItem(key, '1');
    } catch {
      // storage unavailable — dismissal lasts for this page view only
    }
    setDismissedKeys((prev) => [...prev, key]);
  }

  return (
    <div
      role="status"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--sp-2)',
        padding: '0 0 0 var(--sp-4)',
        background: 'var(--c-warning-bg)',
        color: 'var(--c-text)',
        border: '1px solid var(--c-warning)',
        borderRadius: 'var(--r-md)',
        fontFamily: 'var(--font-ui)',
        fontSize: 14,
      }}
    >
      <span style={{ flex: 1, padding: 'var(--sp-2) 0' }}>{message}</span>
      <button type="button" aria-label="Dismiss frost reminder" onClick={dismiss} style={{ ...iconButtonStyle, color: 'var(--c-text)' }}>
        <CloseIcon />
      </button>
    </div>
  );
}
