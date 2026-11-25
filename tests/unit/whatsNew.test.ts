import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  unseenAnnounced,
  readLastSeen,
  markSeen,
  initLastSeen,
} from '../../client/src/lib/whatsNew';
import { WHATS_NEW, type WhatsNewEntry } from '../../client/src/content/whatsNew';

const KEY = 'vernal.whatsNew.lastSeen';

function entry(id: string, announce = true): WhatsNewEntry {
  return { id, date: id.slice(0, 10), title: id, items: ['x'], announce };
}

function stubStorage(initial: Record<string, string> = {}) {
  const store = { ...initial };
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
    },
  });
  return store;
}

function stubThrowingStorage() {
  const boom = () => {
    throw new Error('storage unavailable');
  };
  vi.stubGlobal('window', { localStorage: { getItem: boom, setItem: boom } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('unseenAnnounced', () => {
  const entries = [
    entry('2026-12-10-b'),
    entry('2026-12-05-quiet', false),
    entry('2026-12-01-a'),
    entry('2026-11-30-beta', false),
  ];

  it('returns [] for a null lastSeen', () => {
    expect(unseenAnnounced(entries, null)).toEqual([]);
  });

  it('returns only announce=true entries newer than lastSeen, newest first', () => {
    const shuffled = [entries[2], entries[0], entries[3], entries[1]];
    const ids = unseenAnnounced(shuffled, '2026-11-30-beta').map((e) => e.id);
    expect(ids).toEqual(['2026-12-10-b', '2026-12-01-a']);
  });

  it('returns [] when lastSeen is the newest id', () => {
    expect(unseenAnnounced(entries, '2026-12-10-b')).toEqual([]);
  });

  it('sorts ids that share a date by slug', () => {
    const same = [entry('2026-12-01-a'), entry('2026-12-01-c'), entry('2026-12-01-b')];
    const ids = unseenAnnounced(same, '2026-11-01-old').map((e) => e.id);
    expect(ids).toEqual(['2026-12-01-c', '2026-12-01-b', '2026-12-01-a']);
  });

  it('does not mutate the input', () => {
    const input = [entry('2026-12-01-a'), entry('2026-12-10-b')];
    unseenAnnounced(input, '2026-11-01-old');
    expect(input.map((e) => e.id)).toEqual(['2026-12-01-a', '2026-12-10-b']);
  });
});

describe('initLastSeen', () => {
  it('stores the newest id when nothing is stored', () => {
    const store = stubStorage();
    initLastSeen([entry('2026-12-10-b'), entry('2026-12-01-a')]);
    expect(store[KEY]).toBe('2026-12-10-b');
  });

  it('leaves an existing value alone', () => {
    const store = stubStorage({ [KEY]: '2026-11-01-old' });
    initLastSeen([entry('2026-12-10-b')]);
    expect(store[KEY]).toBe('2026-11-01-old');
  });

  it('stores nothing for an empty list', () => {
    const store = stubStorage();
    initLastSeen([]);
    expect(KEY in store).toBe(false);
  });
});

describe('readLastSeen / markSeen', () => {
  it('round-trips a seen id', () => {
    stubStorage();
    markSeen('2026-12-01-a');
    expect(readLastSeen()).toBe('2026-12-01-a');
  });
});

describe('WHATS_NEW', () => {
  it('is newest first with unique ids', () => {
    const ids = WHATS_NEW.map((e) => e.id);
    for (let i = 1; i < ids.length; i++) expect(ids[i] < ids[i - 1], `${ids[i]} after ${ids[i - 1]}`).toBe(true);
  });

  it('has ids that start with their date, and 1-5 items each', () => {
    for (const e of WHATS_NEW) {
      expect(e.id).toMatch(/^\d{4}-\d{2}-\d{2}-[a-z0-9-]+$/);
      expect(e.id.slice(0, 10)).toBe(e.date);
      expect(e.items.length).toBeGreaterThanOrEqual(1);
      expect(e.items.length).toBeLessThanOrEqual(5);
    }
  });
});

describe('storage failures', () => {
  it('never throw when storage throws', () => {
    stubThrowingStorage();
    expect(readLastSeen()).toBeNull();
    expect(() => markSeen('2026-12-01-a')).not.toThrow();
    expect(() => initLastSeen([entry('2026-12-01-a')])).not.toThrow();
  });
});
