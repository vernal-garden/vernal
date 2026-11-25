import { useState, useSyncExternalStore } from 'react';
import type { CSSProperties } from 'react';
import { WHATS_NEW } from '../content/whatsNew';
import { initLastSeen, markSeen, readLastSeen, unseenAnnounced } from '../lib/whatsNew';
import router from '../routes';
import { HIDDEN_PATHS } from './FeedbackWidget';
import { iconButtonStyle, textButtonStyle } from './guide/styles';
import { CloseIcon } from './shell/icons';

// Announces updates this device hasn't seen. The full history is on the About page.

// Left/right insets with auto margins center the card without a full-width
// wrapper, so nothing beside it blocks clicks.
const cardStyle: CSSProperties = {
  position: 'fixed',
  top: 'calc(var(--shell-content-top, 0px) + var(--sp-3))',
  left: 'var(--sp-4)',
  right: 'var(--sp-4)',
  margin: '0 auto',
  maxWidth: 420,
  boxSizing: 'border-box',
  overflowY: 'auto',
  overscrollBehavior: 'contain',
  // Above the canvas side panels (25), below its popovers (30) and dialogs.
  zIndex: 28,
  padding: 'var(--sp-4)',
  background: 'var(--c-surface)',
  color: 'var(--c-text)',
  border: '1px solid var(--c-border)',
  borderRadius: 'var(--r-lg)',
  boxShadow: 'var(--shadow-lg)',
  fontFamily: 'var(--font-ui)',
};

// The card lives outside <RouterProvider>, so it reads location from the
// router instance instead of useLocation().
function usePathname(): string {
  return useSyncExternalStore(
    (onChange) => router.subscribe(onChange),
    () => router.state.location.pathname,
  );
}

interface Props {
  // Height of the bottom banners (update, pending deletion), as for FeedbackWidget.
  bottomOffset?: number;
}

export default function WhatsNewCard({ bottomOffset = 0 }: Props) {
  const pathname = usePathname();
  // Worked out once, on mount. Running twice (StrictMode) gives the same list.
  const [unseen] = useState(() => {
    initLastSeen(WHATS_NEW);
    return unseenAnnounced(WHATS_NEW, readLastSeen());
  });
  const [dismissed, setDismissed] = useState(false);

  if (dismissed || unseen.length === 0 || HIDDEN_PATHS.has(pathname)) return null;

  const newest = unseen[0];
  const earlier = unseen.length - 1;

  function dismiss() {
    markSeen(newest.id);
    setDismissed(true);
  }

  // Stays above the bottom chrome; a long entry scrolls inside the card.
  const maxHeight = `calc(100dvh - var(--shell-content-top, 0px) - var(--shell-bottom, 0px) - ${bottomOffset}px - 2 * var(--sp-3))`;

  return (
    <div role="status" aria-live="polite" data-print-hide data-testid="whats-new-card" style={{ ...cardStyle, maxHeight }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--sp-2)' }}>
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>What&apos;s new in Vernal</h2>
        <button type="button" aria-label="Dismiss" onClick={dismiss} style={iconButtonStyle}>
          <CloseIcon width={20} height={20} />
        </button>
      </div>

      <p style={{ margin: 'var(--sp-1) 0 0', fontSize: 14, fontWeight: 600 }}>{newest.title}</p>
      <ul
        style={{
          margin: 'var(--sp-1) 0 0',
          paddingLeft: 'var(--sp-5)',
          listStyle: 'disc',
          fontSize: 14,
          lineHeight: 1.5,
          color: 'var(--c-text-2)',
        }}
      >
        {newest.items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      {earlier > 0 && (
        <p style={{ margin: 'var(--sp-2) 0 0', fontSize: 13, color: 'var(--c-text-2)' }}>
          and {earlier} earlier {earlier === 1 ? 'update' : 'updates'}
        </p>
      )}

      <button
        type="button"
        onClick={() => {
          dismiss();
          void router.navigate('/about#whats-new');
        }}
        style={{ ...textButtonStyle, marginTop: 'var(--sp-3)' }}
      >
        See all
      </button>
    </div>
  );
}
