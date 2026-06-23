import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import Konva from 'konva';
import { Layer, Line, Group, Rect, Stage, Text } from 'react-konva';
import type { Bed, BedGrid, BedFreeform, CreateBedPayload, UpdateBedPayload } from '../../hooks/useGarden';

Konva.hitOnDragEnabled = true;

export const GRID_PX = 30;
const ZOOM_STEP = 1.1;
const MIN_SCALE = 0.2;
const MAX_SCALE = 5;
const GRID_HIDE_THRESHOLD = 0.4;
const HANDLE_HALF = 6;

export interface GardenCanvasRef {
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
  focusBed: (bed: Bed) => void;
}

interface Props {
  beds: Bed[];
  selectedBedId: string | null;
  onSelectBed: (bed: Bed | null) => void;
  onDoubleBed: (bed: Bed) => void;
  onCreateBed: (payload: CreateBedPayload) => void;
  onUpdateBedGeometry: (bedId: string, payload: UpdateBedPayload) => void;
  onScaleChange?: (scale: number) => void;
  onOverlapWarning?: (msg: string) => void;
  mode: 'grid' | 'freeform';
  panActive: boolean;
  gardenId: string;
}

type ResizeHandle = 'nw' | 'ne' | 'sw' | 'se';

type ResizePreview =
  | { kind: 'grid'; x: number; y: number; cols: number; rows: number; overlap: boolean }
  | { kind: 'freeform'; points: number[]; overlap: boolean };

// ---- Pure helpers ----

function computeExtents(beds: Bed[]) {
  const MARGIN = 10 * GRID_PX;
  if (beds.length === 0) {
    return { minX: -MARGIN, minY: -MARGIN, maxX: 20 * GRID_PX + MARGIN, maxY: 15 * GRID_PX + MARGIN };
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const bed of beds) {
    if (bed.type === 'grid' && bed.grid) {
      minX = Math.min(minX, bed.grid.x * GRID_PX);
      minY = Math.min(minY, bed.grid.y * GRID_PX);
      maxX = Math.max(maxX, (bed.grid.x + bed.grid.cols) * GRID_PX);
      maxY = Math.max(maxY, (bed.grid.y + bed.grid.rows) * GRID_PX);
    } else if (bed.type === 'freeform' && bed.freeform) {
      for (let i = 0; i < bed.freeform.points.length; i += 2) {
        minX = Math.min(minX, bed.freeform.points[i]);
        minY = Math.min(minY, bed.freeform.points[i + 1]);
        maxX = Math.max(maxX, bed.freeform.points[i]);
        maxY = Math.max(maxY, bed.freeform.points[i + 1]);
      }
    }
  }
  return { minX: minX - MARGIN, minY: minY - MARGIN, maxX: maxX + MARGIN, maxY: maxY + MARGIN };
}

function freeformBbox(points: number[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < points.length; i += 2) {
    minX = Math.min(minX, points[i]);
    minY = Math.min(minY, points[i + 1]);
    maxX = Math.max(maxX, points[i]);
    maxY = Math.max(maxY, points[i + 1]);
  }
  return { minX, minY, maxX, maxY };
}

function getBedBbox(bed: Bed): { x1: number; y1: number; x2: number; y2: number } | null {
  if (bed.type === 'grid' && bed.grid) {
    return {
      x1: bed.grid.x * GRID_PX,
      y1: bed.grid.y * GRID_PX,
      x2: (bed.grid.x + bed.grid.cols) * GRID_PX,
      y2: (bed.grid.y + bed.grid.rows) * GRID_PX,
    };
  }
  if (bed.type === 'freeform' && bed.freeform) {
    const bb = freeformBbox(bed.freeform.points);
    return { x1: bb.minX, y1: bb.minY, x2: bb.maxX, y2: bb.maxY };
  }
  return null;
}

function hitTestHandle(w: { x: number; y: number }, cx: number, cy: number, hitHalf: number): boolean {
  return Math.abs(w.x - cx) <= hitHalf && Math.abs(w.y - cy) <= hitHalf;
}

function pointInPolygon(px: number, py: number, pts: number[]) {
  let inside = false;
  for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) {
    const xi = pts[i], yi = pts[i + 1], xj = pts[j], yj = pts[j + 1];
    if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

function hitTestBeds(w: { x: number; y: number }, bedsArr: Bed[]): Bed | null {
  for (let i = bedsArr.length - 1; i >= 0; i--) {
    const b = bedsArr[i];
    if (b.type === 'grid' && b.grid) {
      const { x, y, cols, rows } = b.grid;
      if (w.x >= x * GRID_PX && w.x <= (x + cols) * GRID_PX &&
          w.y >= y * GRID_PX && w.y <= (y + rows) * GRID_PX) return b;
    } else if (b.type === 'freeform' && b.freeform) {
      if (pointInPolygon(w.x, w.y, b.freeform.points)) return b;
    }
  }
  return null;
}

function worldToCell(wx: number, wy: number) {
  return { cellX: Math.floor(wx / GRID_PX), cellY: Math.floor(wy / GRID_PX) };
}

function gridFromCells(
  a: { cellX: number; cellY: number },
  b: { cellX: number; cellY: number }
) {
  return {
    x: Math.min(a.cellX, b.cellX),
    y: Math.min(a.cellY, b.cellY),
    cols: Math.max(1, Math.abs(b.cellX - a.cellX) + 1),
    rows: Math.max(1, Math.abs(b.cellY - a.cellY) + 1),
  };
}

function bedToPolygon(bed: Bed): number[] | null {
  if (bed.type === 'grid' && bed.grid) {
    const { x, y, cols, rows } = bed.grid;
    return [
      x * GRID_PX, y * GRID_PX,
      (x + cols) * GRID_PX, y * GRID_PX,
      (x + cols) * GRID_PX, (y + rows) * GRID_PX,
      x * GRID_PX, (y + rows) * GRID_PX,
    ];
  }
  if (bed.type === 'freeform' && bed.freeform) return bed.freeform.points;
  return null;
}

function segmentsIntersect(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): boolean {
  const d1x = bx - ax, d1y = by - ay;
  const d2x = dx - cx, d2y = dy - cy;
  const cross = d1x * d2y - d1y * d2x;
  if (Math.abs(cross) < 1e-10) return false;
  const t = ((cx - ax) * d2y - (cy - ay) * d2x) / cross;
  const u = ((cx - ax) * d1y - (cy - ay) * d1x) / cross;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

function polygonsOverlap(ptsA: number[], ptsB: number[]): boolean {
  const nA = ptsA.length / 2;
  const nB = ptsB.length / 2;
  for (let i = 0; i < nA; i++) {
    const ax = ptsA[i * 2], ay = ptsA[i * 2 + 1];
    const bx = ptsA[((i + 1) % nA) * 2], by = ptsA[((i + 1) % nA) * 2 + 1];
    for (let j = 0; j < nB; j++) {
      const cx = ptsB[j * 2], cy = ptsB[j * 2 + 1];
      const dx = ptsB[((j + 1) % nB) * 2], dy = ptsB[((j + 1) % nB) * 2 + 1];
      if (segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy)) return true;
    }
  }
  for (let i = 0; i < nA; i++) {
    if (pointInPolygon(ptsA[i * 2], ptsA[i * 2 + 1], ptsB)) return true;
  }
  for (let j = 0; j < nB; j++) {
    if (pointInPolygon(ptsB[j * 2], ptsB[j * 2 + 1], ptsA)) return true;
  }
  return false;
}

function bedOverlapsAny(candidatePoly: number[], excludeId: string, bedsArr: Bed[]): boolean {
  for (const bed of bedsArr) {
    if (bed.id === excludeId) continue;
    const poly = bedToPolygon(bed);
    if (!poly || poly.length < 4) continue;
    if (polygonsOverlap(candidatePoly, poly)) return true;
  }
  return false;
}

// ---- Component ----

const GardenCanvas = forwardRef<GardenCanvasRef, Props>(({
  beds, selectedBedId, onSelectBed, onDoubleBed,
  onCreateBed, onUpdateBedGeometry,
  onScaleChange, onOverlapWarning, mode, panActive, gardenId: _gardenId,
}, ref) => {
  const stageRef = useRef<Konva.Stage>(null);
  const [scale, setScale] = useState(1);
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [spaceHeld, setSpaceHeld] = useState(false);

  // Grid creation
  const gridDragRef = useRef<{ startCell: { cellX: number; cellY: number }; startWorld: { x: number; y: number }; curCell: { cellX: number; cellY: number }; moved: boolean } | null>(null);
  const [gridPreview, setGridPreview] = useState<{ x: number; y: number; cols: number; rows: number; overlap: boolean } | null>(null);

  // Freeform creation
  const [freeformPts, setFreeformPts] = useState<number[]>([]);
  const freeformPtsRef = useRef<number[]>([]);
  const [cursorWorld, setCursorWorld] = useState<{ x: number; y: number } | null>(null);
  const lastClickTimeRef = useRef(0);

  // Move overlap indicator
  const [moveOverlap, setMoveOverlap] = useState(false);
  const moveOverlapRef = useRef(false);
  const setMoveOverlapSynced = useCallback((v: boolean) => {
    moveOverlapRef.current = v;
    setMoveOverlap(v);
  }, []);

  // Move
  const moveRef = useRef<{ bedId: string; startWorld: { x: number; y: number }; moved: boolean } | null>(null);
  const [dragOffset, setDragOffset] = useState<{ x: number; y: number } | null>(null);
  const dragOffsetRef = useRef<{ x: number; y: number } | null>(null);
  const setDragOffsetSynced = useCallback((v: { x: number; y: number } | null) => {
    dragOffsetRef.current = v;
    setDragOffset(v);
  }, []);

  // Resize
  const resizeRef = useRef<{
    bedId: string;
    handle: ResizeHandle;
    origBbox: { x1: number; y1: number; x2: number; y2: number };
    origPoints?: number[];
  } | null>(null);
  const [resizePreview, setResizePreview] = useState<ResizePreview | null>(null);
  const resizePreviewRef = useRef<ResizePreview | null>(null);
  const setResizePreviewSynced = useCallback((v: ResizePreview | null) => {
    resizePreviewRef.current = v;
    setResizePreview(v);
  }, []);
  const resizeDoneRef = useRef(false);

  const selectedBedIdRef = useRef<string | null>(selectedBedId);
  useEffect(() => { selectedBedIdRef.current = selectedBedId; }, [selectedBedId]);
  const bedsRef = useRef<Bed[]>(beds);
  // committedGeomRef: holds the geometry just committed on move/resize so the canvas
  // renders the correct position immediately, before the parent's beds prop propagates.
  const committedGeomRef = useRef<{ bedId: string; grid?: BedGrid; freeform?: BedFreeform } | null>(null);
  useEffect(() => {
    bedsRef.current = beds;
    // Clear the override only when the beds prop actually carries the committed geometry,
    // so the canvas never flickers back to the pre-move position mid-propagation.
    const c = committedGeomRef.current;
    if (c) {
      const bed = beds.find(b => b.id === c.bedId);
      if (bed) {
        if (c.grid && bed.type === 'grid' && bed.grid) {
          const g = bed.grid;
          if (g.x === c.grid.x && g.y === c.grid.y && g.cols === c.grid.cols && g.rows === c.grid.rows) {
            committedGeomRef.current = null;
          }
        } else if (c.freeform && bed.type === 'freeform' && bed.freeform) {
          const bp = bed.freeform.points;
          const cp = c.freeform.points;
          if (bp.length === cp.length && bp.every((v, i) => v === cp[i])) {
            committedGeomRef.current = null;
          }
        }
      }
    }
  }, [beds]);

  const setFreeformPtsSynced = useCallback((pts: number[]) => {
    freeformPtsRef.current = pts;
    setFreeformPts(pts);
  }, []);

  const closeFreeform = useCallback((pts: number[]) => {
    if (pts.length < 6) { setFreeformPtsSynced([]); setCursorWorld(null); return; }
    if (bedOverlapsAny(pts, '', bedsRef.current)) {
      setFreeformPtsSynced([]);
      setCursorWorld(null);
      onOverlapWarning?.("Beds can't overlap");
      return;
    }
    onCreateBed({
      type: 'freeform',
      label: `Bed ${bedsRef.current.length + 1}`,
      freeform: { points: pts, closed: true },
    });
    setFreeformPtsSynced([]);
    setCursorWorld(null);
  }, [onCreateBed, onOverlapWarning, setFreeformPtsSynced]);

  // Keyboard: space-pan, Escape
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat) {
        e.preventDefault();
        setSpaceHeld(true);
        if (moveRef.current) {
          moveRef.current = null;
          setDragOffsetSynced(null);
        }
      }
      if (e.code === 'Escape') {
        setFreeformPtsSynced([]);
        setCursorWorld(null);
        setGridPreview(null);
        gridDragRef.current = null;
        moveRef.current = null;
        setDragOffsetSynced(null);
        setMoveOverlapSynced(false);
        committedGeomRef.current = null;
        resizeRef.current = null;
        setResizePreviewSynced(null);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceHeld(false);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => { window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp); };
  }, [setFreeformPtsSynced, setDragOffsetSynced, setResizePreviewSynced]);

  // Cursor style
  useEffect(() => {
    const el = stageRef.current?.container();
    if (!el) return;
    if (panActive || spaceHeld) { el.style.cursor = 'grab'; }
    else if (mode === 'freeform') { el.style.cursor = 'crosshair'; }
    else { el.style.cursor = 'default'; }
  }, [panActive, spaceHeld, mode]);

  // Window resize
  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const applyZoom = useCallback((newScale: number, cx: number, cy: number) => {
    const stage = stageRef.current;
    if (!stage) return;
    const clamped = Math.min(Math.max(newScale, MIN_SCALE), MAX_SCALE);
    const old = stage.scaleX();
    const pt = { x: (cx - stage.x()) / old, y: (cy - stage.y()) / old };
    stage.scale({ x: clamped, y: clamped });
    stage.position({ x: cx - pt.x * clamped, y: cy - pt.y * clamped });
    stage.batchDraw();
    setScale(clamped);
    onScaleChange?.(clamped);
  }, [onScaleChange]);

  useImperativeHandle(ref, () => ({
    zoomIn() {
      const s = stageRef.current; if (!s) return;
      applyZoom(s.scaleX() * ZOOM_STEP, s.width() / 2, s.height() / 2);
    },
    zoomOut() {
      const s = stageRef.current; if (!s) return;
      applyZoom(s.scaleX() / ZOOM_STEP, s.width() / 2, s.height() / 2);
    },
    resetZoom() {
      const s = stageRef.current; if (!s) return;
      const cx = s.width() / 2, cy = s.height() / 2;
      const old = s.scaleX();
      const pt = { x: (cx - s.x()) / old, y: (cy - s.y()) / old };
      s.scale({ x: 1, y: 1 });
      s.position({ x: cx - pt.x, y: cy - pt.y });
      s.batchDraw(); setScale(1); onScaleChange?.(1);
    },
    focusBed(bed: Bed) {
      const s = stageRef.current; if (!s) return;
      let cx: number, cy: number;
      if (bed.type === 'grid' && bed.grid) {
        cx = (bed.grid.x + bed.grid.cols / 2) * GRID_PX;
        cy = (bed.grid.y + bed.grid.rows / 2) * GRID_PX;
      } else if (bed.type === 'freeform' && bed.freeform) {
        const bbox = freeformBbox(bed.freeform.points);
        cx = (bbox.minX + bbox.maxX) / 2;
        cy = (bbox.minY + bbox.maxY) / 2;
      } else return;
      const targetScale = 1.5;
      const clamped = Math.min(Math.max(targetScale, MIN_SCALE), MAX_SCALE);
      s.scale({ x: clamped, y: clamped });
      s.position({ x: s.width() / 2 - cx * clamped, y: s.height() / 2 - cy * clamped });
      s.batchDraw();
      setScale(clamped);
      onScaleChange?.(clamped);
    },
  }), [applyZoom, onScaleChange]);

  const handleWheel = useCallback((e: Konva.KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault();
    const stage = stageRef.current; if (!stage) return;
    const pointer = stage.getPointerPosition(); if (!pointer) return;
    const newScale = e.evt.deltaY < 0 ? stage.scaleX() * ZOOM_STEP : stage.scaleX() / ZOOM_STEP;
    applyZoom(newScale, pointer.x, pointer.y);
  }, [applyZoom]);

  const handleMouseDown = useCallback((e: Konva.KonvaEventObject<MouseEvent>) => {
    if (e.evt.button !== 0) return;
    const stage = stageRef.current; if (!stage) return;
    const isPanning = panActive || spaceHeld;
    if (isPanning) return;
    const p = stage.getPointerPosition(); if (!p) return;
    const w = stage.getAbsoluteTransform().copy().invert().point(p);

    // Check resize handles for selected bed before anything else
    // Skip if a freeform polygon is in progress (clicks place vertices, not drag operations)
    if (selectedBedIdRef.current && freeformPtsRef.current.length === 0) {
      const selBed = bedsRef.current.find(b => b.id === selectedBedIdRef.current);
      if (selBed) {
        const bbox = getBedBbox(selBed);
        if (bbox) {
          const currentScale = stage.scaleX();
          const hitHalf = Math.max(HANDLE_HALF, 8 / currentScale);
          const corners: [ResizeHandle, number, number][] = [
            ['nw', bbox.x1, bbox.y1],
            ['ne', bbox.x2, bbox.y1],
            ['sw', bbox.x1, bbox.y2],
            ['se', bbox.x2, bbox.y2],
          ];
          for (const [handle, cx, cy] of corners) {
            if (hitTestHandle(w, cx, cy, hitHalf)) {
              resizeRef.current = {
                bedId: selBed.id,
                handle,
                origBbox: bbox,
                origPoints: selBed.type === 'freeform' ? selBed.freeform?.points : undefined,
              };
              return;
            }
          }
        }
      }
    }

    if (mode === 'grid') {
      const hitBed = hitTestBeds(w, beds);
      if (hitBed) {
        moveRef.current = { bedId: hitBed.id, startWorld: w, moved: false };
        return;
      }
      const cell = worldToCell(w.x, w.y);
      gridDragRef.current = { startCell: cell, startWorld: w, curCell: cell, moved: false };
    } else {
      // freeform mode: only start a move when no polygon is in progress
      if (freeformPtsRef.current.length === 0) {
        const hitBed = hitTestBeds(w, beds);
        if (hitBed) moveRef.current = { bedId: hitBed.id, startWorld: w, moved: false };
      }
    }
  }, [mode, panActive, spaceHeld, beds]);

  const handleMouseMove = useCallback((_e: Konva.KonvaEventObject<MouseEvent>) => {
    const stage = stageRef.current; if (!stage) return;
    const p = stage.getPointerPosition(); if (!p) return;
    const w = stage.getAbsoluteTransform().copy().invert().point(p);

    if (mode === 'freeform') setCursorWorld(w);

    if (resizeRef.current) {
      const { handle, origBbox, origPoints, bedId } = resizeRef.current;
      const bed = bedsRef.current.find(b => b.id === bedId);
      if (!bed) return;

      let { x1, y1, x2, y2 } = origBbox;
      if (handle === 'nw' || handle === 'sw') x1 = w.x;
      if (handle === 'ne' || handle === 'se') x2 = w.x;
      if (handle === 'nw' || handle === 'ne') y1 = w.y;
      if (handle === 'sw' || handle === 'se') y2 = w.y;
      const nx1 = Math.min(x1, x2);
      const ny1 = Math.min(y1, y2);
      const nx2 = Math.max(x1, x2);
      const ny2 = Math.max(y1, y2);

      if (bed.type === 'grid') {
        const gx1 = Math.round(nx1 / GRID_PX);
        const gy1 = Math.round(ny1 / GRID_PX);
        const gx2 = Math.max(gx1 + 1, Math.round(nx2 / GRID_PX));
        const gy2 = Math.max(gy1 + 1, Math.round(ny2 / GRID_PX));
        const gResizePoly = [
          gx1 * GRID_PX, gy1 * GRID_PX,
          gx2 * GRID_PX, gy1 * GRID_PX,
          gx2 * GRID_PX, gy2 * GRID_PX,
          gx1 * GRID_PX, gy2 * GRID_PX,
        ];
        const overlap = bedOverlapsAny(gResizePoly, bedId, bedsRef.current);
        setResizePreviewSynced({ kind: 'grid', x: gx1, y: gy1, cols: gx2 - gx1, rows: gy2 - gy1, overlap });
      } else if (bed.type === 'freeform' && origPoints) {
        const origW = origBbox.x2 - origBbox.x1;
        const origH = origBbox.y2 - origBbox.y1;
        const scaleX = origW > 0 ? (nx2 - nx1) / origW : 1;
        const scaleY = origH > 0 ? (ny2 - ny1) / origH : 1;
        const newPoints = origPoints.map((v, i) =>
          i % 2 === 0
            ? nx1 + (v - origBbox.x1) * scaleX
            : ny1 + (v - origBbox.y1) * scaleY
        );
        const overlap = bedOverlapsAny(newPoints, bedId, bedsRef.current);
        setResizePreviewSynced({ kind: 'freeform', points: newPoints, overlap });
      }
      return;
    }

    if (gridDragRef.current) {
      const { startCell, startWorld, moved } = gridDragRef.current;
      if (!moved && Math.hypot(w.x - startWorld.x, w.y - startWorld.y) > 4) {
        gridDragRef.current.moved = true;
      }
      if (gridDragRef.current.moved) {
        const cell = worldToCell(w.x, w.y);
        gridDragRef.current.curCell = cell;
        const g = gridFromCells(startCell, cell);
        const gPoly = [
          g.x * GRID_PX, g.y * GRID_PX,
          (g.x + g.cols) * GRID_PX, g.y * GRID_PX,
          (g.x + g.cols) * GRID_PX, (g.y + g.rows) * GRID_PX,
          g.x * GRID_PX, (g.y + g.rows) * GRID_PX,
        ];
        const overlap = bedOverlapsAny(gPoly, '', beds);
        setGridPreview({ ...g, overlap });
      }
      return;
    }

    if (moveRef.current) {
      const dx = w.x - moveRef.current.startWorld.x;
      const dy = w.y - moveRef.current.startWorld.y;
      if (!moveRef.current.moved && Math.hypot(dx, dy) > 4) moveRef.current.moved = true;
      if (moveRef.current.moved) {
        setDragOffsetSynced({ x: dx, y: dy });
        // Compute live overlap for the moving bed to show warning colour
        const movingBed = bedsRef.current.find(b => b.id === moveRef.current!.bedId);
        if (movingBed) {
          let candidatePoly: number[] | null = null;
          if (movingBed.type === 'grid' && movingBed.grid) {
            const nx = movingBed.grid.x * GRID_PX + dx;
            const ny = movingBed.grid.y * GRID_PX + dy;
            const bw = movingBed.grid.cols * GRID_PX;
            const bh = movingBed.grid.rows * GRID_PX;
            candidatePoly = [nx, ny, nx + bw, ny, nx + bw, ny + bh, nx, ny + bh];
          } else if (movingBed.type === 'freeform' && movingBed.freeform) {
            candidatePoly = movingBed.freeform.points.map((v, i) => i % 2 === 0 ? v + dx : v + dy);
          }
          if (candidatePoly) {
            setMoveOverlapSynced(bedOverlapsAny(candidatePoly, moveRef.current.bedId, bedsRef.current));
          }
        }
      }
    }
  }, [mode, beds, setDragOffsetSynced, setMoveOverlapSynced, setResizePreviewSynced]);

  const handleMouseUp = useCallback(() => {
    if (resizeRef.current) {
      const { bedId } = resizeRef.current;
      resizeRef.current = null;
      resizeDoneRef.current = true;
      const preview = resizePreviewRef.current;
      setResizePreviewSynced(null);
      if (preview) {
        const bed = bedsRef.current.find(b => b.id === bedId);
        if (bed) {
          if (preview.kind === 'grid' && !preview.overlap) {
            const geom = { x: preview.x, y: preview.y, cols: preview.cols, rows: preview.rows };
            committedGeomRef.current = { bedId, grid: geom };
            onUpdateBedGeometry(bedId, { grid: geom });
          } else if (preview.kind === 'freeform' && bed.freeform && !preview.overlap) {
            const geom = { points: preview.points, closed: bed.freeform.closed };
            committedGeomRef.current = { bedId, freeform: geom };
            onUpdateBedGeometry(bedId, { freeform: geom });
          } else if (preview.overlap) {
            onOverlapWarning?.("Beds can't overlap");
          }
        }
      }
      return;
    }

    if (gridDragRef.current) {
      const wasMoved = gridDragRef.current.moved;
      gridDragRef.current = null;
      if (wasMoved && gridPreview) {
        const preview = gridPreview;
        setGridPreview(null);
        if (!preview.overlap) {
          onCreateBed({ type: 'grid', label: `Bed ${bedsRef.current.length + 1}`, grid: { x: preview.x, y: preview.y, cols: preview.cols, rows: preview.rows } });
        } else {
          onOverlapWarning?.("Beds can't overlap");
        }
        return;
      }
      setGridPreview(null);
      // Not a drag — fall through so handleClick runs selection
      return;
    }

    if (moveRef.current?.moved && dragOffsetRef.current) {
      const { bedId } = moveRef.current;
      const bed = bedsRef.current.find(b => b.id === bedId);
      if (bed) {
        if (bed.type === 'grid' && bed.grid) {
          const newX = Math.round((bed.grid.x * GRID_PX + dragOffsetRef.current.x) / GRID_PX);
          const newY = Math.round((bed.grid.y * GRID_PX + dragOffsetRef.current.y) / GRID_PX);
          const newGrid = { x: newX, y: newY, cols: bed.grid.cols, rows: bed.grid.rows };
          const gPoly = [
            newX * GRID_PX, newY * GRID_PX,
            (newX + bed.grid.cols) * GRID_PX, newY * GRID_PX,
            (newX + bed.grid.cols) * GRID_PX, (newY + bed.grid.rows) * GRID_PX,
            newX * GRID_PX, (newY + bed.grid.rows) * GRID_PX,
          ];
          if (bedOverlapsAny(gPoly, bedId, bedsRef.current)) {
            onOverlapWarning?.("Beds can't overlap");
          } else {
            committedGeomRef.current = { bedId, grid: newGrid };
            onUpdateBedGeometry(bedId, { grid: newGrid });
          }
        } else if (bed.type === 'freeform' && bed.freeform) {
          const newPoints = bed.freeform.points.map((v, i) => i % 2 === 0 ? v + dragOffsetRef.current!.x : v + dragOffsetRef.current!.y);
          if (bedOverlapsAny(newPoints, bedId, bedsRef.current)) {
            onOverlapWarning?.("Beds can't overlap");
          } else {
            const geom = { points: newPoints, closed: bed.freeform.closed };
            committedGeomRef.current = { bedId, freeform: geom };
            onUpdateBedGeometry(bedId, { freeform: geom });
          }
        }
      }
    }
    moveRef.current = null;
    setDragOffsetSynced(null);
    setMoveOverlapSynced(false);
  }, [gridPreview, onCreateBed, onUpdateBedGeometry, onOverlapWarning, setDragOffsetSynced, setMoveOverlapSynced, setResizePreviewSynced]);

  const handleClick = useCallback((e: Konva.KonvaEventObject<MouseEvent>) => {
    if (resizeDoneRef.current) { resizeDoneRef.current = false; return; }
    if (moveRef.current?.moved) { moveRef.current = null; return; }
    if (gridDragRef.current) return;

    const stage = e.target.getStage(); if (!stage) return;
    const p = stage.getPointerPosition(); if (!p) return;
    const w = stage.getAbsoluteTransform().copy().invert().point(p);
    const isPanning = panActive || spaceHeld;

    if (mode === 'freeform' && !isPanning) {
      const inProgress = freeformPtsRef.current.length > 0;

      if (inProgress) {
        // Polygon in progress: place vertex or close, same as before
        const now = Date.now();
        const isDbl = now - lastClickTimeRef.current < 300;
        lastClickTimeRef.current = now;

        if (isDbl && freeformPtsRef.current.length >= 6) {
          const trimmed = freeformPtsRef.current.slice(0, -2);
          setFreeformPtsSynced(trimmed);
          closeFreeform(trimmed);
          return;
        }

        const pts = freeformPtsRef.current;
        if (pts.length >= 4) {
          const currentScale = stageRef.current?.scaleX() ?? 1;
          const distScreen = Math.hypot(w.x - pts[0], w.y - pts[1]) * currentScale;
          if (distScreen <= 12) { closeFreeform(pts); return; }
        }
        setFreeformPtsSynced([...pts, w.x, w.y]);
        return;
      }

      // No polygon in progress: select/deselect/start drawing
      const hit = hitTestBeds(w, beds);
      if (hit) {
        onSelectBed(hit);
        return;
      }
      if (selectedBedIdRef.current) {
        // Deselect; next click will place the first vertex
        onSelectBed(null);
        return;
      }
      // Nothing selected, no hit: place first vertex and start drawing
      lastClickTimeRef.current = Date.now();
      setFreeformPtsSynced([w.x, w.y]);
      return;
    }

    const hit = hitTestBeds(w, beds);
    onSelectBed(hit ?? null);
  }, [mode, panActive, spaceHeld, beds, onSelectBed, closeFreeform, setFreeformPtsSynced]);

  const handleDblClick = useCallback((e: Konva.KonvaEventObject<MouseEvent>) => {
    const stage = e.target.getStage(); if (!stage) return;
    const p = stage.getPointerPosition(); if (!p) return;
    const w = stage.getAbsoluteTransform().copy().invert().point(p);
    const hit = hitTestBeds(w, beds);
    if (hit) onDoubleBed(hit);
  }, [beds, onDoubleBed]);

  const extents = useMemo(() => computeExtents(beds), [beds]);

  const gridLines = useMemo(() => {
    const lines: ReactNode[] = [];
    const startX = Math.floor(extents.minX / GRID_PX) * GRID_PX;
    const startY = Math.floor(extents.minY / GRID_PX) * GRID_PX;
    for (let x = startX; x <= extents.maxX; x += GRID_PX) {
      lines.push(<Line key={`v${x}`} points={[x, extents.minY, x, extents.maxY]} stroke="#ddd5c4" strokeWidth={0.5} />);
    }
    for (let y = startY; y <= extents.maxY; y += GRID_PX) {
      lines.push(<Line key={`h${y}`} points={[extents.minX, y, extents.maxX, y]} stroke="#ddd5c4" strokeWidth={0.5} />);
    }
    return lines;
  }, [extents]);

  const selectedBed = beds.find(b => b.id === selectedBedId) ?? null;

  return (
    <Stage
      ref={stageRef}
      width={size.w}
      height={size.h}
      draggable={panActive || spaceHeld}
      onWheel={handleWheel}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onClick={handleClick}
      onDblClick={handleDblClick}
    >
      {/* Layer 1: grid lines */}
      <Layer listening={false}>
        {scale >= GRID_HIDE_THRESHOLD && gridLines}
      </Layer>

      {/* Layer 2: beds */}
      <Layer listening={true}>
        {beds.map(bed => {
          const selected = bed.id === selectedBedId;
          const isMoving = dragOffset != null && moveRef.current?.bedId === bed.id;
          const isMoveOverlapping = isMoving && moveOverlap;

          if (bed.type === 'grid' && bed.grid) {
            // Use committedGeomRef while the parent's optimistic beds prop catches up (Fix C)
            const committed = !isMoving && committedGeomRef.current?.bedId === bed.id
              ? (committedGeomRef.current.grid ?? null)
              : null;
            const { x, y, cols, rows } = committed ?? bed.grid;
            const renderX = isMoving ? bed.grid.x * GRID_PX + dragOffset!.x : x * GRID_PX;
            const renderY = isMoving ? bed.grid.y * GRID_PX + dragOffset!.y : y * GRID_PX;
            const w = cols * GRID_PX;
            const h = rows * GRID_PX;

            const cellLines: ReactNode[] = [];
            for (let col = 1; col < cols; col++) {
              cellLines.push(<Line key={`vc${col}`} points={[col * GRID_PX, 0, col * GRID_PX, h]} stroke="#b8d0ba" strokeWidth={0.5} />);
            }
            for (let row = 1; row < rows; row++) {
              cellLines.push(<Line key={`hr${row}`} points={[0, row * GRID_PX, w, row * GRID_PX]} stroke="#b8d0ba" strokeWidth={0.5} />);
            }

            return (
              <Group key={bed.id} id={bed.id} x={renderX} y={renderY}>
                <Rect width={w} height={h}
                  fill={isMoveOverlapping ? 'rgba(200,80,80,0.4)' : '#d4edda'}
                  stroke={isMoveOverlapping ? '#c05050' : (selected ? '#1a5c3a' : '#2d6a4f')}
                  strokeWidth={selected ? 3 : 1.5} cornerRadius={2} />
                {cellLines}
                <Text text={bed.label || 'Bed'} fontSize={12} x={4} y={4} fill="#264a2e" fontFamily="Georgia, serif" />
              </Group>
            );
          }

          if (bed.type === 'freeform' && bed.freeform) {
            const { closed } = bed.freeform;
            // Use committedGeomRef while parent catches up (Fix C)
            const committedF = !isMoving && committedGeomRef.current?.bedId === bed.id
              ? (committedGeomRef.current.freeform ?? null)
              : null;
            const pts = isMoving
              ? bed.freeform.points.map((v, i) => i % 2 === 0 ? v + dragOffset!.x : v + dragOffset!.y)
              : (committedF?.points ?? bed.freeform.points);
            let sumX = 0, sumY = 0;
            for (let i = 0; i < pts.length; i += 2) { sumX += pts[i]; sumY += pts[i + 1]; }
            const labelX = sumX / (pts.length / 2);
            const labelY = sumY / (pts.length / 2);

            return (
              <Group key={bed.id} id={bed.id}>
                <Line points={pts} closed={closed}
                  fill={isMoveOverlapping ? 'rgba(200,80,80,0.4)' : 'rgba(255,243,205,0.7)'}
                  stroke={isMoveOverlapping ? '#c05050' : (selected ? '#8a5a00' : '#b8860b')}
                  strokeWidth={selected ? 3 : 1.5} dash={[6, 4]} />
                <Text text={bed.label || 'Bed'} fontSize={12} x={labelX} y={labelY} fill="#5a3e00" fontFamily="Georgia, serif" />
              </Group>
            );
          }

          return null;
        })}
      </Layer>

      {/* Layer 3: creation previews + resize handles */}
      <Layer listening={false}>
        {/* Grid creation preview */}
        {gridPreview && (
          <Rect
            x={gridPreview.x * GRID_PX}
            y={gridPreview.y * GRID_PX}
            width={gridPreview.cols * GRID_PX}
            height={gridPreview.rows * GRID_PX}
            fill={gridPreview.overlap ? 'rgba(200,80,80,0.25)' : 'rgba(80,160,100,0.25)'}
            stroke={gridPreview.overlap ? '#c05050' : '#2d6a4f'}
            strokeWidth={1.5}
            dash={[6, 3]}
          />
        )}

        {/* Freeform creation preview */}
        {mode === 'freeform' && freeformPts.length >= 2 && (
          <>
            <Line points={freeformPts} stroke="#b8860b" strokeWidth={1.5} dash={[4, 3]} closed={false} />
            {cursorWorld && (
              <Line
                points={[freeformPts[freeformPts.length - 2], freeformPts[freeformPts.length - 1], cursorWorld.x, cursorWorld.y]}
                stroke="#b8860b" strokeWidth={1} dash={[4, 4]} opacity={0.5}
              />
            )}
            {cursorWorld && freeformPts.length >= 4 && (() => {
              const dist = Math.hypot(cursorWorld.x - freeformPts[0], cursorWorld.y - freeformPts[1]) * scale;
              return dist <= 12 ? (
                <Rect x={freeformPts[0] - 5} y={freeformPts[1] - 5} width={10} height={10}
                  fill="rgba(184,134,11,0.3)" stroke="#b8860b" strokeWidth={1.5} />
              ) : null;
            })()}
            {Array.from({ length: freeformPts.length / 2 }, (_, i) => (
              <Rect key={i} x={freeformPts[i * 2] - 3} y={freeformPts[i * 2 + 1] - 3}
                width={6} height={6} fill="#b8860b" />
            ))}
          </>
        )}

        {/* Resize handles + bbox frame for selected bed */}
        {selectedBed && (() => {
          const bbox = getBedBbox(selectedBed);
          if (!bbox) return null;
          const { x1, y1, x2, y2 } = bbox;
          const corners: [number, number][] = [[x1, y1], [x2, y1], [x1, y2], [x2, y2]];
          return (
            <>
              <Rect x={x1} y={y1} width={x2 - x1} height={y2 - y1}
                stroke="#2d6a4f" strokeWidth={1} dash={[4, 3]} fill="transparent" />
              {corners.map(([cx, cy], i) => (
                <Rect key={i}
                  x={cx - HANDLE_HALF} y={cy - HANDLE_HALF}
                  width={HANDLE_HALF * 2} height={HANDLE_HALF * 2}
                  fill="#fff" stroke="#2d6a4f" strokeWidth={1.5}
                />
              ))}
            </>
          );
        })()}

        {/* Resize preview */}
        {resizePreview && (
          resizePreview.kind === 'grid' ? (
            <Rect
              x={resizePreview.x * GRID_PX}
              y={resizePreview.y * GRID_PX}
              width={resizePreview.cols * GRID_PX}
              height={resizePreview.rows * GRID_PX}
              fill={resizePreview.overlap ? 'rgba(200,80,80,0.25)' : 'rgba(80,160,100,0.2)'}
              stroke={resizePreview.overlap ? '#c05050' : '#2d6a4f'}
              strokeWidth={1.5}
              dash={[4, 3]}
            />
          ) : (
            <Line
              points={resizePreview.points}
              closed
              fill={resizePreview.overlap ? 'rgba(200,80,80,0.25)' : 'rgba(255,243,205,0.5)'}
              stroke={resizePreview.overlap ? '#c05050' : '#b8860b'}
              strokeWidth={1.5}
              dash={[4, 3]}
            />
          )
        )}
      </Layer>
    </Stage>
  );
});

GardenCanvas.displayName = 'GardenCanvas';
export default GardenCanvas;
