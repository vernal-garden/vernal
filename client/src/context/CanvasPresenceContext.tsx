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
export function useRegisterCanvas(): void {
  const { setCanvasMounted } = useContext(CanvasPresenceContext);
  useEffect(() => {
    setCanvasMounted(true);
    return () => setCanvasMounted(false);
  }, [setCanvasMounted]);
}
