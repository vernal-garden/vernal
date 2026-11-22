// Lets any page open the feedback panel. FeedbackWidget lives outside the router and
// any page-level context, so this is a plain module-level subscription.

type Listener = () => void;

const listeners = new Set<Listener>();
let opener: HTMLElement | null = null;

// Records the focused element so the panel can hand focus back when it closes.
export function openFeedbackPanel(): void {
  const active = document.activeElement;
  opener = active instanceof HTMLElement ? active : null;
  listeners.forEach((cb) => cb());
}

export function onOpenFeedbackPanel(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getFeedbackOpener(): HTMLElement | null {
  return opener;
}
