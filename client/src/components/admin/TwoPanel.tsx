import type { ReactNode } from 'react';

export interface TwoPanelProps {
  list: ReactNode;
  detail: ReactNode;
  /** Width of the list column in px (default 340). */
  listWidth?: number;
}

// List + detail columns filling the available height; each scrolls on its own.
// The parent must give it a height (e.g. height: '100%' inside the admin main area).
export default function TwoPanel({ list, detail, listWidth = 340 }: TwoPanelProps) {
  return (
    <div style={{ display: 'flex', flex: 1, height: '100%', minHeight: 0 }}>
      <div
        style={{
          width: listWidth,
          flexShrink: 0,
          overflowY: 'auto',
          borderRight: '1px solid var(--c-border)',
          background: 'var(--c-surface)',
        }}
      >
        {list}
      </div>
      <div style={{ flex: 1, minWidth: 0, overflowY: 'auto' }}>{detail}</div>
    </div>
  );
}
