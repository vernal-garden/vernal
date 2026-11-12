import type { BetaLifetimeRow } from './adminApi';

export type LifetimeGroup = 'all' | 'qualify' | 'close' | 'noState' | 'eligible' | 'notYet';
export type LifetimeStatus = 'Qualifies' | 'Close' | 'Not yet';

export function inGroup(
  row: Pick<BetaLifetimeRow, 'qualifies' | 'borderline' | 'residenceState' | 'grantEligible'>,
  group: LifetimeGroup,
): boolean {
  switch (group) {
    case 'all': return true;
    case 'qualify': return row.qualifies;
    case 'close': return row.borderline;
    case 'noState': return row.qualifies && row.residenceState === null;
    case 'eligible': return row.grantEligible;
    case 'notYet': return !row.qualifies && !row.borderline;
  }
}

export function statusOf(row: Pick<BetaLifetimeRow, 'qualifies' | 'borderline'>): LifetimeStatus {
  if (row.qualifies) return 'Qualifies';
  if (row.borderline) return 'Close';
  return 'Not yet';
}

export function statusRank(row: Pick<BetaLifetimeRow, 'qualifies' | 'borderline'>): number {
  if (row.qualifies) return 0;
  if (row.borderline) return 1;
  return 2;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ['2026-12-07', '2026-12-14', '2027-01-04'] -> 'Dec 7, 14, Jan 4'. The month
// shows on the first date and wherever it changes. Plain dates, no time zone.
export function formatWeeks(weeks: string[]): string {
  let lastMonth = -1;
  return weeks
    .map((w) => {
      const [, m, d] = w.split('-').map(Number);
      const month = m - 1;
      const text = month === lastMonth ? `${d}` : `${MONTHS[month]} ${d}`;
      lastMonth = month;
      return text;
    })
    .join(', ');
}

export function feedbackSplit(f: { notes: number; quickAnswers: number; surveys: number }): string {
  const parts: string[] = [];
  if (f.notes > 0) parts.push(`${f.notes} ${f.notes === 1 ? 'note' : 'notes'}`);
  if (f.quickAnswers > 0) parts.push(`${f.quickAnswers} quick`);
  if (f.surveys > 0) parts.push(`${f.surveys} ${f.surveys === 1 ? 'survey' : 'surveys'}`);
  return parts.join(', ');
}

// The Pacific calendar day of endsAt minus one millisecond: the last day
// counted. '2027-01-30T08:00:00.000Z' -> 'January 29'.
export function windowEndDay(endsAt: string): string {
  const last = new Date(new Date(endsAt).getTime() - 1);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    month: 'long',
    day: 'numeric',
  }).format(last);
}
