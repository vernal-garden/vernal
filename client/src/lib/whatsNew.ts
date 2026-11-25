import type { WhatsNewEntry } from '../content/whatsNew';

const KEY = 'vernal.whatsNew.lastSeen';

// A device with nothing stored starts caught up, so it never sees old entries as new.
export function unseenAnnounced(entries: WhatsNewEntry[], lastSeenId: string | null): WhatsNewEntry[] {
  if (lastSeenId === null) return [];
  return entries
    .filter((e) => e.announce && e.id > lastSeenId)
    .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

export function readLastSeen(): string | null {
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function markSeen(id: string): void {
  try {
    window.localStorage.setItem(KEY, id);
  } catch {
    // storage unavailable — the card may show again next visit
  }
}

export function initLastSeen(entries: WhatsNewEntry[]): void {
  if (readLastSeen() !== null || entries.length === 0) return;
  markSeen(entries[0].id);
}
