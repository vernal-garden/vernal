import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

// Lets app-shell chrome (the feedback FAB) know when the garden canvas is on
// screen, since the canvas claims the bottom edge on narrow viewports.
interface CanvasPresence {
  canvasMounted: boolean;
  setCanvasMounted: (mounted: boolean) => void;
}

const CanvasPresenceContext = createContext<CanvasPresence>({
  canvasMounted: false,
  setCanvasMounted: () => {},
});

export function CanvasPresenceProvider({ children }: { children: ReactNode }) {
  const [canvasMounted, setCanvasMounted] = useState(false);
  return (
    <CanvasPresenceContext.Provider value={{ canvasMounted, setCanvasMounted }}>
      {children}
    </CanvasPresenceContext.Provider>
  );
}

export function useCanvasMounted(): boolean {
  return useContext(CanvasPresenceContext).canvasMounted;
}

// Call from the canvas page: flags the canvas as mounted for the lifetime of the caller.
// Other pages that hold the bottom-right corner (the mobile harvest log's "+"
// button) pass `active` to move the feedback FAB left while they need it.
export function useRegisterCanvas(active = true): void {
  const { setCanvasMounted } = useContext(CanvasPresenceContext);
  useEffect(() => {
    if (!active) return;
    setCanvasMounted(true);
    return () => setCanvasMounted(false);
  }, [active, setCanvasMounted]);
}
