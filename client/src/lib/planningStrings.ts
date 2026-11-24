import type { StartMethod } from '../hooks/usePlantings';
import { shortDate } from './guideDates';

// All Phase 76b UI copy lives here. Pure module: no React, no window access.

export function formatNames(names: string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  if (names.length <= 4) {
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  }
  return `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
}

export function formatShortDate(iso: string, viewedSeason: number): string {
  const year = iso.slice(0, 4);
  return Number(year) === viewedSeason ? shortDate(iso) : `${shortDate(iso)}, ${year}`;
}

// Season switch
export const SEASON_THIS = 'This season';
export const OVERLAY_NONE = 'No overlay';
export const seasonPlan = (next: number): string => `Plan ${next}`;

// Next-season canvas notice
export const nextSeasonNotice = (next: number): string =>
  `Planning ${next}. Plants here are planned until you mark them sown.`;

// New-season prompt
export const nextSeasonPromptTitle = (next: number, current: number): string =>
  `Start ${next} with your ${current} beds?`;
export const nextSeasonPromptBody = (current: number): string =>
  `Beds come over empty. Your ${current} garden stays as it is.`;
export const copyBeds = (current: number): string => `Copy ${current} beds`;
export const START_FRESH = 'Start fresh';
export const COPYING_BEDS = 'Copying beds…';

// Placement checkbox
export const NOT_IN_GROUND = 'Not in the ground yet';
export const plannedFor = (next: number): string => `Planned for ${next}`;

// Inspect popover
export const PLANNED_LINE: Record<StartMethod, string> = {
  sown: 'Planned · sowing seed',
  transplanted: 'Planned · transplanting a start',
};
export const MARK_BUTTON: Record<StartMethod, string> = {
  sown: 'Mark sown',
  transplanted: 'Mark transplanted',
};

// Bed panel + mark-in-ground sheet
export const BED_PANEL_LINK = 'Mark plants in the ground';
export const SHEET_TITLE = "What's in the ground?";
export const METHODS_KEPT = 'Each plant goes in the way you planned it.';
export const markInGround = (n: number): string => `Mark ${n} in the ground`;
export const CHOOSE_PLANTS = 'Choose plants to mark';
export const PLANTING_DATE_LABEL = 'Planting date';
// Sheet method control reuses StartMethodControl's own labels
// ("Sowing seed here" / "Transplanting a start").

// Guide
export const PLANNED_TAG = 'Planned';
export type NudgeKind = 'indoorStart' | 'transplant' | 'directSow';
export const NUDGE_OPEN: Record<NudgeKind, string> = {
  indoorStart: 'Time to start indoors',
  transplant: 'Time to transplant',
  directSow: 'Time to sow',
};
export const NUDGE_CLOSING: Record<NudgeKind, string> = {
  indoorStart: 'Final week to start indoors',
  transplant: 'Final week to transplant',
  directSow: 'Final week to sow',
};
export const untilDate = (date: string): string => `Until ${date}`;

// Bell
export const bellOpenTitle = (garden: string): string => `Planting time in ${garden}`;
export const bellClosingTitle = (garden: string): string => `Closing soon in ${garden}`;

export type ReminderOpenGroup = 'indoor_start' | 'transplant' | 'transplant_sown' | 'direct_sow';
export const BELL_OPEN_LINE: Record<ReminderOpenGroup, (names: string) => string> = {
  indoor_start: (names) => `Start indoors: ${names}`,
  transplant: (names) => `Transplant: ${names}`,
  transplant_sown: (names) => `Started ${names} indoors? Harden them off, then plant out.`,
  direct_sow: (names) => `Sow: ${names}`,
};

export type ReminderWindowKind = 'indoor_start' | 'transplant' | 'direct_sow';
export const BELL_CLOSING_LINE: Record<ReminderWindowKind, (names: string, date: string) => string> = {
  indoor_start: (names, date) => `Start ${names} indoors by ${date}`,
  transplant: (names, date) => `Transplant ${names} by ${date}`,
  direct_sow: (names, date) => `Sow ${names} by ${date}`,
};
