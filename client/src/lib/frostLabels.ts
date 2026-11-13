// Frost copy for the Planting Guide. Every frost string is built here from the
// garden's frost object and zone, so a wording change never needs a server
// deploy.

import type { GuideGarden, WindowSource } from '../types/plantingGuide';
import { MONTH_LONG, parseDay, shortDate } from './guideDates';

type Frost = GuideGarden['frost'];

export type FrostState = 'own' | 'noaa' | 'rough' | 'station' | 'stationFrostFree' | 'frostFree' | 'none';

// The leading integer of a zone string: '6b' -> 6, ' 10a' -> 10.
export function zoneNumber(zone: string): number | null {
  const match = /^\s*(\d+)/.exec(zone);
  return match ? Number(match[1]) : null;
}

export function frostState(frost: Frost): FrostState {
  if (frost.frostSource === 'account_frost') return 'own';
  if (frost.frostFree && frost.frostBasis === 'station') return 'stationFrostFree';
  if (frost.frostFree) return 'frostFree';
  if (frost.frostSource === 'zone_estimate') {
    if (frost.frostBasis === 'noaa') return 'noaa';
    if (frost.frostBasis === 'rough') return 'rough';
    if (frost.frostBasis === 'station') return 'station';
  }
  return 'none';
}

export function stripFrostLine(frost: Frost, zone: string): string | null {
  const d = frost.lastSpringFrost;
  const n = zoneNumber(zone);
  switch (frostState(frost)) {
    case 'own':
      return d ? `Last frost ${shortDate(d)} (your date)` : null;
    case 'noaa':
      return d && n !== null ? `About ${shortDate(d)}, estimated from NOAA records for zone ${n}` : null;
    case 'rough':
      return d && n !== null ? `About ${shortDate(d)}, a rough estimate for zone ${n}` : null;
    case 'station':
      return d && frost.stationName ? `About ${shortDate(d)}, from the ${frost.stationName} weather record` : null;
    case 'stationFrostFree':
      return frost.stationName ? `Frost is rare at the ${frost.stationName} weather station.` : null;
    case 'frostFree':
      return n !== null ? `No last frost set. Zone ${n} is usually frost-free.` : null;
    case 'none':
      return 'No data, add manually';
  }
}

export function framePrompt(frost: Frost): { text: string; link: string } | null {
  switch (frostState(frost)) {
    case 'noaa':
    case 'rough':
    case 'station':
      return { text: 'These windows use an estimated last frost.', link: 'Set your own date' };
    case 'frostFree':
    case 'stationFrostFree':
      return { text: 'Get frost some years?', link: 'Set a last frost date' };
    default:
      return null;
  }
}

export function windowSourceLabel(source: WindowSource | null): string {
  switch (source) {
    case 'custom': return 'Your custom date';
    case 'account_frost': return 'From your last frost date';
    case 'zone_estimate': return 'Estimated from your last frost';
    default: return 'No data, add manually';
  }
}

export function springBannerText(frost: Frost): { text: string; link: string | null } | null {
  if (!frost.lastSpringFrost) return null;
  const { m, d } = parseDay(frost.lastSpringFrost);
  const day = `${MONTH_LONG[m - 1]} ${d}`;
  switch (frostState(frost)) {
    case 'own':
      return { text: `Your last frost date is ${day}. Indoor starts due soon.`, link: null };
    case 'noaa':
    case 'rough':
    case 'station':
      return { text: `Your estimated last frost is about ${day}. Indoor starts due soon.`, link: 'Set your own date' };
    default:
      return null;
  }
}

export const FROST_COPY = {
  editorLabel: 'Your last spring frost date',
  editorHint: 'The date your last spring frost usually comes. A local extension office or a gardening neighbor usually knows it.',
  save: 'Save',
  cancel: 'Cancel',
  saved: 'Planting dates updated.',
  saveFailed: "Couldn't save. Try again.",
  setDateName: 'Set your last frost date',
  onboardingLabel: 'Know your last frost date?',
  onboardingHint: 'Vernal has an estimate, but your own date is better. Every planting window counts from it.',
} as const;
