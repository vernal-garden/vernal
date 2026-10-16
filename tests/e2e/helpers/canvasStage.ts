import { expect, type APIRequestContext, type Page } from '@playwright/test';

// Phase 53 canvas helpers: bed creation beyond the fixed BED_GRID of
// canvasSeasons.ts, and reading the live Konva stage transform so tests can
// map world coordinates (bed geometry from the API) to screen pixels.

// Must match GRID_PX in client/src/components/canvas/GardenCanvas.tsx.
export const GRID_PX = 30;

export interface GridRect { x: number; y: number; cols: number; rows: number }
export interface Point { x: number; y: number }
export interface ScreenRect { left: number; top: number; right: number; bottom: number }

export async function createGridBedAt(
  api: APIRequestContext, gardenId: string, season: number, label: string, grid: GridRect,
): Promise<string> {
  const resp = await api.post(`/api/gardens/${gardenId}/beds`, {
    data: { type: 'grid', label, season, grid },
  });
  expect(resp.status(), await resp.text()).toBe(201);
  return String((await resp.json()).id);
}

// A closed freeform polygon; `points` are world pixels as a flat [x0, y0, x1, y1, ...] list.
export async function createFreeformBed(
  api: APIRequestContext, gardenId: string, season: number, label: string, points: number[],
): Promise<string> {
  const resp = await api.post(`/api/gardens/${gardenId}/beds`, {
    data: { type: 'freeform', label, season, freeform: { points, closed: true } },
  });
  expect(resp.status(), await resp.text()).toBe(201);
  return String((await resp.json()).id);
}

// Rectangle as a freeform polygon.
export function rectPoints(x1: number, y1: number, x2: number, y2: number): number[] {
  return [x1, y1, x2, y1, x2, y2, x1, y2];
}

// The live stage transform plus the stage container's page offset. Read from
// window.Konva (react-konva leaves it set) — the same mechanism
// canvasSeasons.ts uses for marker positions. Null until a stage is mounted.
export interface StageView { scale: number; x: number; y: number; left: number; top: number }

export async function stageView(page: Page): Promise<StageView | null> {
  return page.evaluate(() => {
    type KonvaStage = {
      width(): number; scaleX(): number; x(): number; y(): number;
      container(): HTMLDivElement;
    };
    const konva = (window as unknown as { Konva?: { stages?: KonvaStage[] } }).Konva;
    const stages = (konva?.stages ?? []).filter(s => s.container().isConnected);
    if (stages.length === 0) return null;
    const stage = stages.reduce((a, b) => (b.width() > a.width() ? b : a));
    const rect = stage.container().getBoundingClientRect();
    return { scale: stage.scaleX(), x: stage.x(), y: stage.y(), left: rect.left, top: rect.top };
  });
}

export async function requireStageView(page: Page): Promise<StageView> {
  const view = await stageView(page);
  if (!view) throw new Error('No Konva stage on the page');
  return view;
}

export function worldToScreen(view: StageView, p: Point): Point {
  return { x: view.left + view.x + p.x * view.scale, y: view.top + view.y + p.y * view.scale };
}

export function worldRectToScreen(view: StageView, x1: number, y1: number, x2: number, y2: number): ScreenRect {
  const a = worldToScreen(view, { x: x1, y: y1 });
  const b = worldToScreen(view, { x: x2, y: y2 });
  return { left: a.x, top: a.y, right: b.x, bottom: b.y };
}

export function gridBedScreenRect(view: StageView, g: GridRect): ScreenRect {
  return worldRectToScreen(view, g.x * GRID_PX, g.y * GRID_PX, (g.x + g.cols) * GRID_PX, (g.y + g.rows) * GRID_PX);
}

export function pointsScreenRect(view: StageView, points: number[]): ScreenRect {
  const xs = points.filter((_, i) => i % 2 === 0);
  const ys = points.filter((_, i) => i % 2 === 1);
  return worldRectToScreen(view, Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
}

// World centre of a grid cell.
export function cellCenter(g: GridRect, cell: Point): Point {
  return { x: (g.x + cell.x + 0.5) * GRID_PX, y: (g.y + cell.y + 0.5) * GRID_PX };
}

export function rectWithin(inner: ScreenRect, outer: ScreenRect, tolerance = 1): boolean {
  return inner.left >= outer.left - tolerance && inner.top >= outer.top - tolerance
    && inner.right <= outer.right + tolerance && inner.bottom <= outer.bottom + tolerance;
}

export function describeRect(r: ScreenRect): string {
  const f = (n: number) => n.toFixed(1);
  return `(${f(r.left)}, ${f(r.top)})–(${f(r.right)}, ${f(r.bottom)})`;
}

// Screen point for a world point, asserting the canvas itself is what a
// press there would hit (not a toolbar, note or popover drawn over it).
export async function canvasScreenPoint(page: Page, world: Point): Promise<Point> {
  const p = worldToScreen(await requireStageView(page), world);
  const hitTag = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName ?? null, p);
  expect(hitTag, `element at (${p.x.toFixed(1)}, ${p.y.toFixed(1)})`).toBe('CANVAS');
  return p;
}
