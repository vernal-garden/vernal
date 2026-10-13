import { useSyncExternalStore } from 'react';

// Below 768px is mobile. The .98 keeps a 767.5px (zoomed / fractional) viewport
// on the mobile side without overlapping a 768px min-width query.
export const MOBILE_QUERY = '(max-width: 767.98px)';

function subscribe(onChange: () => void): () => void {
  const mql = window.matchMedia(MOBILE_QUERY);
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}

export function useIsMobile(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(MOBILE_QUERY).matches,
    () => false,
  );
}
