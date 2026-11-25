// Entries are written by the Vernal Marketing Director. Keep newest first.
// Never edit an entry's id after it ships: it is what readers' "seen" state points at.
// A new entry's id must sort above every id already shipped, or it is never announced.

export interface WhatsNewEntry {
  id: string; // 'YYYY-MM-DD-slug', unique, sortable
  date: string; // YYYY-MM-DD
  title: string;
  items: string[]; // 1-5 short lines
  announce: boolean; // false = history only, no card
  link?: { label: string; to: string }; // in-app route only
}

export const WHATS_NEW: WhatsNewEntry[] = [
  {
    id: '2026-12-01-beta',
    date: '2026-12-01',
    title: 'The beta begins',
    items: ['Welcome, and thanks for testing. Each update will be listed here as it lands, newest first.'],
    announce: false,
  },
  {
    id: '2026-11-23-next-season-planning',
    date: '2026-11-23',
    title: 'Plan next season',
    items: [
      'Switch the canvas to next season and lay out your beds ahead of time.',
      "Mark a planting as not in the ground yet. It won't start growing until you mark it sown or transplanted.",
      'Mark several plants in a bed as in the ground at once.',
      'Get a reminder in the bell when a sowing window opens, and again a week before it closes.',
    ],
    announce: false,
    link: { label: 'Open your garden', to: '/' },
  },
  {
    id: '2026-11-21-about-feedback',
    date: '2026-11-21',
    title: 'Feedback, right in the app',
    items: ['"Report a bug or request a feature" on the About page now opens the feedback panel instead of GitHub.'],
    announce: false,
  },
];
