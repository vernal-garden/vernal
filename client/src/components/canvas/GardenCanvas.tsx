import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import Konva from 'konva';
import { Circle, Layer, Line, Group, Rect, Stage, Text } from 'react-konva';
import type { Bed, CreateBedPayload, UpdateBedPayload, Garden } from '../../hooks/useGarden';
import type { Planting, ArmedSeed, PlantingsByBedId } from '../../hooks/usePlantings';
import { computeFit } from '../../lib/fit';
import FitLine from './FitLine';

Konva.hitOnDragEnabled = true;

export const GRID_PX = 30;
const ZOOM_STEP = 1.1;
const MIN_SCALE = 0.2;
const MAX_SCALE = 5;
const GRID_HIDE_THRESHOLD = 0.4;
const HANDLE_HALF = 6;
const MARKER_RADIUS = GRID_PX * 0.38;
const MARKER_HIT_RADIUS = GRID_PX * 0.5;

const MARKER_COLORS = [
  '#2d6a4f', '#b5652a', '#5e3d8a', '#1a5f7a',
  '#8b4513', '#4a7c59', '#7a3b3b', '#3b6e8c',
];

function markerColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return MARKER_COLORS[Math.abs(h) % MARKER_COLORS.length];
}

function markerLabel(planting: Planting): string {
  const name = planting._commonName ?? '';
  if (!name) return '•';
  return name.slice(0, 3).toUpperCase();
}

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
  // Phase 19
  garden: Garden | null;
  plantingsByBedId: PlantingsByBedId;
  armedSeed: ArmedSeed | null;
  onConfirmPlacement: (
    bedId: string,
    cell: { x: number; y: number } | null,
    point: { x: number; y: number } | null,
    qty: number,
    date: string | null,
  ) => void;
  onConfirmRemoval: (planting: Planting) => void;
}

type ResizeHandle = 'nw' | 'ne' | 'sw' | 'se';

type ResizePreview =
  | { kind: 'grid'; x: number; y: number; cols: number; rows: number; overlap: boolean }
  | { kind: 'freeform'; points: number[]; overlap: boolean };

type PendingPlacement = {
  bedId: string;
  cell?: { x: number; y: number };
  point?: { x: number; y: number };
  screenX: number;
  screenY: number;
};

type PendingRemoval = {
  planting: Planting;
  screenX: number;
  screenY: number;
};

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

function getBedCurrentOverlaps(bed: Bed, bedsArr: Bed[]): Set<string> {
  const currentPoly = bedToPolygon(bed);
  if (!currentPoly || currentPoly.length < 4) return new Set();
  const result = new Set<string>();
  for (const other of bedsArr) {
    if (other.id === bed.id) continue;
    const otherPoly = bedToPolygon(other);
    if (!otherPoly || otherPoly.length < 4) continue;
    if (polygonsOverlap(currentPoly, otherPoly)) result.add(other.id);
  }
  return result;
}

function introducesNewOverlap(
  candidatePoly: number[],
  excludeId: string,
  preExisting: Set<string>,
  bedsArr: Bed[],
): boolean {
  for (const bed of bedsArr) {
    if (bed.id === excludeId || preExisting.has(bed.id)) continue;
    const poly = bedToPolygon(bed);
    if (!poly || poly.length < 4) continue;
    if (polygonsOverlap(candidatePoly, poly)) return true;
  }
  return false;
}

// ---- Marker world-coords helper ----

function markerWorldCenter(
  planting: Planting,
  bed: Bed,
): { x: number; y: number } | null {
  if (planting.cell && bed.type === 'grid' && bed.grid) {
    return {
      x: (bed.grid.x + planting.cell.x + 0.5) * GRID_PX,
      y: (bed.grid.y + planting.cell.y + 0.5) * GRID_PX,
    };
  }
  if (planting.point) return planting.point;
  return null;
}

// ---- Component ----

const GardenCanvas = forwardRef<GardenCanvasRef, Props>(({
  beds, selectedBedId, onSelectBed, onDoubleBed,
  onCreateBed, onUpdateBedGeometry,
  onScaleChange, onOverlapWarning, mode, panActive, gardenId: _gardenId,
  garden, plantingsByBedId, armedSeed,
  onConfirmPlacement, onConfirmRemoval,
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

  const dragStartOverlapsRef = useRef<Set<string>>(new Set());

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
  const moveDoneRef = useRef(false);
  const gridCreateDoneRef = useRef(false);

  const selectedBedIdRef = useRef<string | null>(selectedBedId);
  useEffect(() => { selectedBedIdRef.current = selectedBedId; }, [selectedBedId]);

  // Synced refs for event handlers (avoids stale closures without adding to dep arrays)
  const bedsRef = useRef<Bed[]>(beds);
  bedsRef.current = beds;

  const plantingsByBedIdRef = useRef<PlantingsByBedId>({});
  plantingsByBedIdRef.current = plantingsByBedId;

  const armedSeedRef = useRef<ArmedSeed | null>(null);
  armedSeedRef.current = armedSeed;

  const setFreeformPtsSynced = useCallback((pts: number[]) => {
    freeformPtsRef.current = pts;
    setFreeformPts(pts);
  }, []);

  // Phase 19: placement + removal popovers
  const [pendingPlacement, setPendingPlacement] = useState<PendingPlacement | null>(null);
  const pendingPlacementRef = useRef<PendingPlacement | null>(null);
  const setPendingPlacementSynced = useCallback((v: PendingPlacement | null) => {
    pendingPlacementRef.current = v;
    setPendingPlacement(v);
  }, []);
  const [placementQty, setPlacementQty] = useState(1);
  const [placementDate, setPlacementDate] = useState('');

  const [pendingRemoval, setPendingRemoval] = useState<PendingRemoval | null>(null);
  const pendingRemovalRef = useRef<PendingRemoval | null>(null);
  const setPendingRemovalSynced = useCallback((v: PendingRemoval | null) => {
    pendingRemovalRef.current = v;
    setPendingRemoval(v);
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

  // Keyboard handlers
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
        resizeRef.current = null;
        setResizePreviewSynced(null);
        setPendingPlacementSynced(null);
        setPendingRemovalSynced(null);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceHeld(false);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => { window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp); };
  }, [setFreeformPtsSynced, setDragOffsetSynced, setResizePreviewSynced, setMoveOverlapSynced, setPendingPlacementSynced, setPendingRemovalSynced]);

  // Cursor style
  useEffect(() => {
    const el = stageRef.current?.container();
    if (!el) return;
    if (panActive || spaceHeld) { el.style.cursor = 'grab'; }
    else if (armedSeed) { el.style.cursor = 'crosshair'; }
    else if (mode === 'freeform') { el.style.cursor = 'crosshair'; }
    else { el.style.cursor = 'default'; }
  }, [panActive, spaceHeld, mode, armedSeed]);

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

    // Resize handles (skip if freeform polygon in progress)
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
              dragStartOverlapsRef.current = getBedCurrentOverlaps(selBed, bedsRef.current);
              return;
            }
          }
        }
      }
    }

    // Don't start move/draw when armed (placement click is handled in handleClick)
    if (armedSeedRef.current) return;

    if (mode === 'grid') {
      const hitBed = hitTestBeds(w, bedsRef.current);
      if (hitBed) {
        moveRef.current = { bedId: hitBed.id, startWorld: w, moved: false };
        dragStartOverlapsRef.current = getBedCurrentOverlaps(hitBed, bedsRef.current);
        return;
      }
      const cell = worldToCell(w.x, w.y);
      gridDragRef.current = { startCell: cell, startWorld: w, curCell: cell, moved: false };
    } else {
      if (freeformPtsRef.current.length === 0) {
        const hitBed = hitTestBeds(w, bedsRef.current);
        if (hitBed) {
          moveRef.current = { bedId: hitBed.id, startWorld: w, moved: false };
          dragStartOverlapsRef.current = getBedCurrentOverlaps(hitBed, bedsRef.current);
        }
      }
    }
  }, [mode, panActive, spaceHeld]);

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
        const overlap = introducesNewOverlap(gResizePoly, bedId, dragStartOverlapsRef.current, bedsRef.current);
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
        const overlap = introducesNewOverlap(newPoints, bedId, dragStartOverlapsRef.current, bedsRef.current);
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
        const overlap = bedOverlapsAny(gPoly, '', bedsRef.current);
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
            setMoveOverlapSynced(introducesNewOverlap(candidatePoly, moveRef.current.bedId, dragStartOverlapsRef.current, bedsRef.current));
          }
        }
      }
    }
  }, [mode, setDragOffsetSynced, setMoveOverlapSynced, setResizePreviewSynced]);

  const handleMouseUp = useCallback(() => {
    if (resizeRef.current) {
      const { bedId } = resizeRef.current;
      resizeRef.current = null;
      const preview = resizePreviewRef.current;
      setResizePreviewSynced(null);
      if (preview) {
        resizeDoneRef.current = true;
        const bed = bedsRef.current.find(b => b.id === bedId);
        if (bed) {
          if (preview.kind === 'grid' && !preview.overlap) {
            onUpdateBedGeometry(bedId, { grid: { x: preview.x, y: preview.y, cols: preview.cols, rows: preview.rows } });
          } else if (preview.kind === 'freeform' && bed.freeform && !preview.overlap) {
            onUpdateBedGeometry(bedId, { freeform: { points: preview.points, closed: bed.freeform.closed } });
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
      if (wasMoved) {
        gridCreateDoneRef.current = true;
        const preview = gridPreview;
        setGridPreview(null);
        if (preview && !preview.overlap) {
          onCreateBed({ type: 'grid', label: `Bed ${bedsRef.current.length + 1}`, grid: { x: preview.x, y: preview.y, cols: preview.cols, rows: preview.rows } });
        } else if (preview?.overlap) {
          onOverlapWarning?.("Beds can't overlap");
        }
        return;
      }
      setGridPreview(null);
      return;
    }

    if (moveRef.current?.moved && dragOffsetRef.current) {
      moveDoneRef.current = true;
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
          if (introducesNewOverlap(gPoly, bedId, dragStartOverlapsRef.current, bedsRef.current)) {
            onOverlapWarning?.("Beds can't overlap");
          } else {
            onUpdateBedGeometry(bedId, { grid: newGrid });
          }
        } else if (bed.type === 'freeform' && bed.freeform) {
          const newPoints = bed.freeform.points.map((v, i) => i % 2 === 0 ? v + dragOffsetRef.current!.x : v + dragOffsetRef.current!.y);
          if (introducesNewOverlap(newPoints, bedId, dragStartOverlapsRef.current, bedsRef.current)) {
            onOverlapWarning?.("Beds can't overlap");
          } else {
            onUpdateBedGeometry(bedId, { freeform: { points: newPoints, closed: bed.freeform.closed } });
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
    if (moveDoneRef.current) { moveDoneRef.current = false; return; }
    if (gridCreateDoneRef.current) { gridCreateDoneRef.current = false; return; }

    const stage = e.target.getStage(); if (!stage) return;
    const p = stage.getPointerPosition(); if (!p) return;
    const w = stage.getAbsoluteTransform().copy().invert().point(p);
    const isPanning = panActive || spaceHeld;

    // Close any open popovers if user clicks elsewhere on canvas
    if (pendingPlacementRef.current || pendingRemovalRef.current) {
      setPendingPlacementSynced(null);
      setPendingRemovalSynced(null);
      return;
    }

    if (isPanning) return;

    // Freeform polygon in progress: always handle polygon, skip placement/removal
    if (mode === 'freeform' && freeformPtsRef.current.length > 0) {
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

    // Placement mode: armed seed + selected bed
    const armed = armedSeedRef.current;
    if (armed && selectedBedIdRef.current) {
      const selBed = bedsRef.current.find(b => b.id === selectedBedIdRef.current);
      if (selBed) {
        let placement: { cell?: { x: number; y: number }; point?: { x: number; y: number } } | null = null;

        if (selBed.type === 'grid' && selBed.grid) {
          const { x: gx, y: gy, cols, rows } = selBed.grid;
          const cellX = Math.floor((w.x - gx * GRID_PX) / GRID_PX);
          const cellY = Math.floor((w.y - gy * GRID_PX) / GRID_PX);
          if (cellX >= 0 && cellX < cols && cellY >= 0 && cellY < rows) {
            placement = { cell: { x: cellX, y: cellY } };
          }
        } else if (selBed.type === 'freeform' && selBed.freeform) {
          if (pointInPolygon(w.x, w.y, selBed.freeform.points)) {
            placement = { point: { x: Math.round(w.x), y: Math.round(w.y) } };
          }
        }

        if (placement) {
          const screenPos = stage.getAbsoluteTransform().point(w);
          setPendingPlacementSynced({
            bedId: selBed.id,
            ...placement,
            screenX: screenPos.x,
            screenY: screenPos.y,
          });
          setPlacementQty(1);
          setPlacementDate('');
          return;
        }
      }
    }

    // Marker hit check for removal (only when not armed)
    if (!armed) {
      let nearest: Planting | null = null;
      let nearestDist = MARKER_HIT_RADIUS;
      for (const [bedId, plantings] of Object.entries(plantingsByBedIdRef.current)) {
        const bed = bedsRef.current.find(b => b.id === bedId);
        if (!bed) continue;
        for (const planting of plantings) {
          const center = markerWorldCenter(planting, bed);
          if (!center) continue;
          const dist = Math.hypot(w.x - center.x, w.y - center.y);
          if (dist < nearestDist) {
            nearest = planting;
            nearestDist = dist;
          }
        }
      }
      if (nearest) {
        const nearestBed = bedsRef.current.find(b => b.id === nearest!.bedId);
        const center = nearestBed ? markerWorldCenter(nearest, nearestBed) : null;
        const screenPos = center
          ? stage.getAbsoluteTransform().point(center)
          : { x: p.x, y: p.y };
        setPendingRemovalSynced({ planting: nearest, screenX: screenPos.x, screenY: screenPos.y });
        return;
      }
    }

    // Normal selection flow
    if (mode === 'freeform' && !isPanning) {
      const hit = hitTestBeds(w, bedsRef.current);
      if (hit) { onSelectBed(hit); return; }
      if (selectedBedIdRef.current) { onSelectBed(null); return; }
      // Start freeform drawing
      lastClickTimeRef.current = Date.now();
      setFreeformPtsSynced([w.x, w.y]);
      return;
    }

    const hit = hitTestBeds(w, bedsRef.current);
    onSelectBed(hit ?? null);
  }, [mode, panActive, spaceHeld, onSelectBed, closeFreeform, setFreeformPtsSynced, setPendingPlacementSynced, setPendingRemovalSynced]);

  const handleDblClick = useCallback((e: Konva.KonvaEventObject<MouseEvent>) => {
    const stage = e.target.getStage(); if (!stage) return;
    const p = stage.getPointerPosition(); if (!p) return;
    const w = stage.getAbsoluteTransform().copy().invert().point(p);
    const hit = hitTestBeds(w, bedsRef.current);
    if (hit) onDoubleBed(hit);
  }, [onDoubleBed]);

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

  // Build placement popover
  const placementPopover = (() => {
    if (!pendingPlacement) return null;
    const selBed = beds.find(b => b.id === pendingPlacement.bedId) ?? null;
    const fit = selBed && garden && armedSeed
      ? computeFit({ garden, bed: selBed, spacingInches: armedSeed.spacingInches })
      : null;

    const popW = 248;
    const popH = 260;
    let left = pendingPlacement.screenX + 12;
    if (left + popW > size.w - 8) left = pendingPlacement.screenX - popW - 12;
    let top = pendingPlacement.screenY - popH / 2;
    if (top < 8) top = 8;
    if (top + popH > size.h - 8) top = size.h - popH - 8;

    return (
      <div style={{
        position: 'absolute', left, top, width: popW,
        background: '#faf7f2', border: '1px solid #d8ceba', borderRadius: 10,
        boxShadow: '0 4px 24px rgba(0,0,0,0.22)', padding: 16, zIndex: 30,
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}>
        {fit && armedSeed && (
          <div style={{ marginBottom: 12 }}>
            <FitLine fit={fit} name={armedSeed.commonName} spacingInches={armedSeed.spacingInches} />
          </div>
        )}
        <div style={{ marginBottom: 10 }}>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 600, letterSpacing: '0.07em', textTransform: 'uppercase', color: '#9a8e7e', marginBottom: 4 }}>
            Quantity
          </label>
          <input
            type="number" min={1} max={99} value={placementQty}
            onChange={e => setPlacementQty(Math.max(1, parseInt(e.target.value) || 1))}
            style={{ width: '100%', boxSizing: 'border-box', padding: '6px 10px', borderRadius: 6, border: '1px solid #d0c8b8', fontSize: 13, fontFamily: 'inherit' }}
          />
        </div>
        <div style={{ marginBottom: 14 }}>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 600, letterSpacing: '0.07em', textTransform: 'uppercase', color: '#9a8e7e', marginBottom: 4 }}>
            Planting date (optional)
          </label>
          <input
            type="date" value={placementDate}
            onChange={e => setPlacementDate(e.target.value)}
            style={{ width: '100%', boxSizing: 'border-box', padding: '6px 10px', borderRadius: 6, border: '1px solid #d0c8b8', fontSize: 13, fontFamily: 'inherit' }}
          />
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => setPendingPlacementSynced(null)}
            style={{ flex: 1, padding: '8px', borderRadius: 6, border: '1px solid #d8ceba', background: 'transparent', cursor: 'pointer', fontSize: 12 }}
          >
            Cancel
          </button>
          <button
            onClick={() => {
              onConfirmPlacement(
                pendingPlacement.bedId,
                pendingPlacement.cell ?? null,
                pendingPlacement.point ?? null,
                placementQty,
                placementDate || null,
              );
              setPendingPlacementSynced(null);
            }}
            style={{ flex: 1, padding: '8px', borderRadius: 6, border: 'none', background: '#2d6a4f', color: '#fff', cursor: 'pointer', fontSize: 12 }}
          >
            Place
          </button>
        </div>
      </div>
    );
  })();

  // Build removal popover
  const removalPopover = (() => {
    if (!pendingRemoval) return null;
    const popW = 200;
    const popH = 110;
    let left = pendingRemoval.screenX + 12;
    if (left + popW > size.w - 8) left = pendingRemoval.screenX - popW - 12;
    let top = pendingRemoval.screenY - popH / 2;
    if (top < 8) top = 8;
    if (top + popH > size.h - 8) top = size.h - popH - 8;

    return (
      <div style={{
        position: 'absolute', left, top, width: popW,
        background: '#faf7f2', border: '1px solid #d8ceba', borderRadius: 10,
        boxShadow: '0 4px 24px rgba(0,0,0,0.22)', padding: 16, zIndex: 30,
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}>
        <div style={{ fontSize: 13, color: '#2c3e2c', marginBottom: 12, fontWeight: 500 }}>
          {pendingRemoval.planting._commonName ?? 'Remove plant?'}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => setPendingRemovalSynced(null)}
            style={{ flex: 1, padding: '7px', borderRadius: 6, border: '1px solid #d8ceba', background: 'transparent', cursor: 'pointer', fontSize: 12 }}
          >
            Cancel
          </button>
          <button
            onClick={() => {
              onConfirmRemoval(pendingRemoval.planting);
              setPendingRemovalSynced(null);
            }}
            style={{ flex: 1, padding: '7px', borderRadius: 6, border: 'none', background: '#c04040', color: '#fff', cursor: 'pointer', fontSize: 12 }}
          >
            Remove
          </button>
        </div>
      </div>
    );
  })();

  return (
    <div style={{ position: 'relative', width: size.w, height: size.h }}>
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
              const { x, y, cols, rows } = bed.grid;
              const renderX = isMoving ? x * GRID_PX + dragOffset!.x : x * GRID_PX;
              const renderY = isMoving ? y * GRID_PX + dragOffset!.y : y * GRID_PX;
              const bw = cols * GRID_PX;
              const bh = rows * GRID_PX;

              const cellLines: ReactNode[] = [];
              for (let col = 1; col < cols; col++) {
                cellLines.push(<Line key={`vc${col}`} points={[col * GRID_PX, 0, col * GRID_PX, bh]} stroke="#b8d0ba" strokeWidth={0.5} />);
              }
              for (let row = 1; row < rows; row++) {
                cellLines.push(<Line key={`hr${row}`} points={[0, row * GRID_PX, bw, row * GRID_PX]} stroke="#b8d0ba" strokeWidth={0.5} />);
              }

              return (
                <Group key={bed.id} id={bed.id} x={renderX} y={renderY}>
                  <Rect width={bw} height={bh}
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
              const pts = isMoving
                ? bed.freeform.points.map((v, i) => i % 2 === 0 ? v + dragOffset!.x : v + dragOffset!.y)
                : bed.freeform.points;
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

        {/* Layer 3: planting markers (visual only — clicks resolved in JS) */}
        <Layer listening={false}>
          {beds.map(bed => {
            const plantings = plantingsByBedId[bed.id] ?? [];
            const isMoving = dragOffset != null && moveRef.current?.bedId === bed.id;
            const offsetX = isMoving ? dragOffset!.x : 0;
            const offsetY = isMoving ? dragOffset!.y : 0;

            return plantings.map(planting => {
              const center = markerWorldCenter(planting, bed);
              if (!center) return null;
              const cx = center.x + offsetX;
              const cy = center.y + offsetY;
              const seedId = planting.cambiumSeedId ?? planting.seedId ?? planting.id;
              const color = markerColor(seedId);
              const label = markerLabel(planting);

              return (
                <Group key={planting.id}>
                  <Circle x={cx} y={cy} radius={MARKER_RADIUS} fill={color} opacity={0.88} />
                  <Text
                    text={label}
                    x={cx - MARKER_RADIUS}
                    y={cy - 5}
                    width={MARKER_RADIUS * 2}
                    fontSize={8}
                    align="center"
                    fill="#fff"
                    fontStyle="bold"
                    listening={false}
                  />
                </Group>
              );
            });
          })}
        </Layer>

        {/* Layer 4: creation previews + resize handles */}
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

      {placementPopover}
      {removalPopover}
    </div>
  );
});

GardenCanvas.displayName = 'GardenCanvas';
export default GardenCanvas;
