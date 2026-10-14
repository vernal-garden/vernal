import { expect, type APIRequestContext, type Page } from '@playwright/test';

// Must match GRID_PX in client/src/components/canvas/GardenCanvas.tsx.
const GRID_PX = 30;

// Where the canvas beds go. Away from the stage's top-left corner, which the
// toolbar / shell can cover, and inside a Pixel 7 viewport (412 px wide) at
// the canvas's initial scale of 1.
export const BED_GRID = { x: 6, y: 8, cols: 4, rows: 4 };
// The marker cell inside that bed.
export const MARKER_CELL = { x: 1, y: 1 };

export async function createGridBed(
  api: APIRequestContext, gardenId: string, season: number, label: string,
): Promise<string> {
  const resp = await api.post(`/api/gardens/${gardenId}/beds`, {
    data: { type: 'grid', label, season, grid: BED_GRID },
  });
  expect(resp.status(), await resp.text()).toBe(201);
  return String((await resp.json()).id);
}

export async function createCellPlanting(
  api: APIRequestContext, gardenId: string, bedId: string, seedId: number,
  plantingDate: string | null = null, cell = MARKER_CELL,
): Promise<string> {
  const resp = await api.post(`/api/gardens/${gardenId}/beds/${bedId}/plantings`, {
    data: { seedId, quantity: 1, cell, plantingDate },
  });
  expect(resp.status(), await resp.text()).toBe(201);
  return String((await resp.json()).id);
}

export async function listBeds(
  api: APIRequestContext, gardenId: string, season: number,
): Promise<Array<{ id: string; label: string; season: number }>> {
  const resp = await api.get(`/api/gardens/${gardenId}/beds?season=${season}`);
  expect(resp.ok()).toBe(true);
  return (await resp.json()).data;
}

// Screen position of a grid cell's marker centre. Read from the live Konva
// stage (react-konva leaves window.Konva set) so pan/zoom and the stage's
// offset in the page are accounted for, rather than assuming scale 1 at (0,0).
async function markerScreenPoint(
  page: Page, cell = MARKER_CELL, bed = BED_GRID,
): Promise<{ x: number; y: number }> {
  const world = { x: (bed.x + cell.x + 0.5) * GRID_PX, y: (bed.y + cell.y + 0.5) * GRID_PX };
  const point = await page.evaluate((w) => {
    type KonvaStage = {
      width(): number;
      container(): HTMLDivElement;
      getAbsoluteTransform(): { point(p: { x: number; y: number }): { x: number; y: number } };
    };
    const konva = (window as unknown as { Konva?: { stages?: KonvaStage[] } }).Konva;
    const stages = (konva?.stages ?? []).filter(s => s.container().isConnected);
    if (stages.length === 0) return null;
    const stage = stages.reduce((a, b) => (b.width() > a.width() ? b : a));
    const p = stage.getAbsoluteTransform().point(w);
    const rect = stage.container().getBoundingClientRect();
    const x = rect.left + p.x;
    const y = rect.top + p.y;
    const hit = document.elementFromPoint(x, y);
    return { x, y, hitTag: hit?.tagName ?? null };
  }, world);
  if (!point) throw new Error('No Konva stage on the page');
  // Something drawn over the canvas at this spot (toolbar, prompt card) would
  // swallow the click; fail loudly rather than with a missing popover.
  expect(point.hitTag, `element at marker (${point.x}, ${point.y})`).toBe('CANVAS');
  return { x: point.x, y: point.y };
}

export const inspectPopover = (page: Page, plant: string) => page.getByRole('dialog', { name: plant });

// Clicks (desktop) or taps (mobile) the marker until its popover is open.
// Retried because plantings load after the stage mounts; a press only
// re-fires while the popover is closed, since a press on the canvas with the
// popover open closes it.
export async function openMarkerPopover(
  page: Page, plant: string, opts: { tap?: boolean } = {},
): Promise<void> {
  const popover = inspectPopover(page, plant);
  await expect(async () => {
    if (!(await popover.isVisible())) {
      const { x, y } = await markerScreenPoint(page);
      if (opts.tap) await page.touchscreen.tap(x, y);
      else await page.mouse.click(x, y);
    }
    await expect(popover).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
}
