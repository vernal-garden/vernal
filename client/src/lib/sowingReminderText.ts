import {
  BELL_CLOSING_LINE,
  BELL_OPEN_LINE,
  bellClosingTitle,
  bellOpenTitle,
  formatNames,
  formatShortDate,
  type ReminderOpenGroup,
  type ReminderWindowKind,
} from './planningStrings';

export interface ReminderSection {
  title: string;
  lines: string[];
}

const OPEN_ORDER: ReminderOpenGroup[] = ['indoor_start', 'transplant', 'transplant_sown', 'direct_sow'];
const CLOSING_ORDER: ReminderWindowKind[] = ['indoor_start', 'transplant', 'direct_sow'];

function isStr(v: unknown): v is string {
  return typeof v === 'string';
}

// Turns a sowing_reminder notification payload into bell sections. Reads
// defensively: anything unexpected is skipped, and null means nothing to show.
export function formatSowingReminder(payload: unknown): ReminderSection[] | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.gardenName !== 'string' || typeof p.season !== 'number') return null;
  const garden = p.gardenName;
  const season = p.season;

  const openLines: string[] = [];
  const open = p.open;
  if (typeof open === 'object' && open !== null) {
    const o = open as Record<string, unknown>;
    for (const key of OPEN_ORDER) {
      const names = o[key];
      if (!Array.isArray(names)) continue;
      const clean = names.filter(isStr);
      if (clean.length === 0) continue;
      openLines.push(BELL_OPEN_LINE[key](formatNames(clean)));
    }
  }

  const groups = new Map<string, { kind: ReminderWindowKind; endsOn: string; names: string[] }>();
  if (Array.isArray(p.closing)) {
    for (const item of p.closing) {
      if (typeof item !== 'object' || item === null) continue;
      const c = item as Record<string, unknown>;
      if (!isStr(c.name) || !isStr(c.endsOn) || !isStr(c.windowKind)) continue;
      const kind = CLOSING_ORDER.find((k) => k === c.windowKind);
      if (!kind) continue;
      const gk = `${kind}|${c.endsOn}`;
      const g = groups.get(gk);
      if (g) g.names.push(c.name);
      else groups.set(gk, { kind, endsOn: c.endsOn, names: [c.name] });
    }
  }
  const closingLines = [...groups.values()]
    .sort((a, b) => {
      const k = CLOSING_ORDER.indexOf(a.kind) - CLOSING_ORDER.indexOf(b.kind);
      if (k !== 0) return k;
      return a.endsOn < b.endsOn ? -1 : a.endsOn > b.endsOn ? 1 : 0;
    })
    .map((g) => BELL_CLOSING_LINE[g.kind](formatNames(g.names), formatShortDate(g.endsOn, season)));

  const sections: ReminderSection[] = [];
  if (openLines.length > 0) sections.push({ title: bellOpenTitle(garden), lines: openLines });
  if (closingLines.length > 0) sections.push({ title: bellClosingTitle(garden), lines: closingLines });
  return sections.length > 0 ? sections : null;
}
