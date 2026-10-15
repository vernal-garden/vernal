import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import Konva from 'konva';
import { Circle, Layer, Line, Group, Rect, Shape, Stage, Text } from 'react-konva';
import type { Bed, CreateBedPayload, UpdateBedPayload, Garden } from '../../hooks/useGarden';
import type { Planting, ArmedSeed, PlantingsByBedId } from '../../hooks/usePlantings';
import { computeFit } from '../../lib/fit';
import { apiUrl } from '../../lib/api';
import FitLine from './FitLine';
import { useRegisterCanvas } from '../../context/CanvasPresenceContext';
import { STAGE_NAMES, isHarvestReady } from '../../lib/growthStages';
import { shortDate } from '../../lib/guideDates';
import { useIsMobile } from '../../hooks/useIsMobile';
import { drawStageMark, markerTier } from './stageMarks';

Konva.hitOnDragEnabled = true;

export const GRID_PX = 30;
const ZOOM_STEP = 1.1;
const MIN_SCALE = 0.2;
const MAX_SCALE = 5;
const GRID_HIDE_THRESHOLD = 0.4;
const HANDLE_HALF = 6;
const MARKER_RADIUS = GRID_PX * 0.38;
const MARKER_HIT_RADIUS = GRID_PX * 0.5;

// Phase 53: fit-to-beds framing and the mobile view-only gestures.
const FIT_MARGIN_PX = 40;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SLOP_PX = 24;
const DOUBLE_TAP_ANIM_S = 0.25;

// Phase 41: garden thumbnails
const THUMB_LONG_SIDE_PX = 640;
const THUMB_PAD = 24;
const THUMB_DEBOUNCE_MS = 5000;

// Phase 50: past-season overlay (read-only, drawn under the current markers).
// WD: confirm opacity and tint
const OVERLAY_OPACITY = 0.35;
// WD: confirm opacity and tint
const OVERLAY_TINT = '#8A9499';
// Module constant so the memoised PlantingMarker keeps a stable `plain` prop.
const OVERLAY_MARKER_PLAIN = { fill: OVERLAY_TINT, opacity: OVERLAY_OPACITY };
const EMPTY_BEDS: Bed[] = [];
const EMPTY_PLANTINGS: PlantingsByBedId = {};

const MARKER_COLORS = [
  '#2d6a4f', '#b5652a', '#5e3d8a', '#1a5f7a',
  '#8b4513', '#4a7c59', '#7a3b3b', '#3b6e8c',
];

const REDUCED_MOTION = typeof window !== 'undefined'
  && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function markerColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return MARKER_COLORS[Math.abs(h) % MARKER_COLORS.length];
}

function markerLabel(planting: Planting): string {
  const name = planting.commonName ?? planting._commonName ?? '';
  if (!name) return '•';
  return name.slice(0, 3).toUpperCase();
}

export interface GardenCanvasRef {
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
  focusBed: (bed: Bed) => void;
  // Phase 53: frame all current-season beds (scale capped at 1).
  fitToBeds: () => void;
  captureThumbnail: () => Promise<Blob | null>;
}

interface Props {
  beds: Bed[];
  selectedBedId: string | null;
  onSelectBed: (bed: Bed | null) => void;
  onDoubleBed: (bed: Bed) => void;
  onCreateBed: (payload: CreateBedPayload) => void | Promise<void>;
  onUpdateBedGeometry: (bedId: string, payload: UpdateBedPayload) => void;
  onScaleChange?: (scale: number) => void;
  onOverlapWarning?: (msg: string) => void;
  mode: 'grid' | 'freeform';
  panActive: boolean;
  gardenId: string;
  // Phase 19
  garden: Garden | null;
  plantingsByBedId: PlantingsByBedId;
  // Phase 41: true while plantings for gardenId are being fetched
  plantingsLoading?: boolean;
  armedSeed: ArmedSeed | null;
  onConfirmPlacement: (
    bedId: string,
    cell: { x: number; y: number } | null,
    point: { x: number; y: number } | null,
    qty: number,
    date: string | null,
  ) => void;
  onConfirmRemoval: (planting: Planting) => void;
  // Phase 50: "Mark as harvested" in the inspection popover. Rejects on failure.
  onMarkHarvested?: (planting: Planting) => Promise<void>;
  // Phase 20: companion indicators
  conflictedIds?: Set<string>;
  conflictedBedIds?: Set<string>;
  latestPlacing?: { id: string; seq: number } | null;
  occupancyByBedId?: Record<string, { consumed: number; capacity: number; over: boolean }>;
  relationshipBetween?: (a: string, b: string) => 'beneficial' | 'antagonistic' | null;
  // Phase 50: `${gardenId}:${season}` of the last completed plantings load,
  // and the callback that records stages as shown (PATCH displayed-stage).
  plantingsLoadedKey?: string | null;
  onStagesDisplayed?: (plantingIds: string[]) => void;
  // Phase 50: a past season's layout drawn read-only between the bed and
  // marker layers. Never hit-tested, never animated, never acknowledged.
  overlayBeds?: Bed[];
  overlayPlantingsByBedId?: PlantingsByBedId;
  // Phase 53: `${gardenId}:${season}` of the last completed beds load. The
  // canvas fits the beds once per key (garden open or season switch).
  bedsLoadedKey?: string | null;
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

// Phase 50: inspection popover. Holds ids, not the planting, so it always
// renders the latest planting (e.g. after "Mark as harvested").
type PendingInspect = {
  plantingId: string;
  bedId: string;
  screenX: number;
  screenY: number;
} & PopoverBand;

// Phase 53: mobile bed popover (tap on an empty area inside a current bed).
type PendingBedInspect = {
  bedId: string;
  screenX: number;
  screenY: number;
} & PopoverBand;

// Shared by the plant and bed popovers: to the right of the anchor, flipped
// to the left near the right edge, vertically centred and kept on screen.
// Vertically it stays within [minY + 8, maxY - 8]: the whole stage on desktop
// (0..height), the band between the shell bars on mobile.
function anchoredPopoverPosition(
  anchorX: number, anchorY: number, popW: number, popH: number, viewW: number,
  minY: number, maxY: number,
): { left: number; top: number } {
  let left = anchorX + 12;
  if (left + popW > viewW - 8) left = anchorX - popW - 12;
  if (left < 8) left = 8;
  let top = anchorY - popH / 2;
  if (top < minY + 8) top = minY + 8;
  if (top + popH > maxY - 8) top = maxY - popH - 8;
  top = Math.max(minY + 8, top);
  return { left, top };
}

// Visible vertical band captured when a popover opens (mobile only).
type PopoverBand = { bandTop?: number; bandBottom?: number };

// Touch gesture bookkeeping so a tap only inspects when it was a single,
// stationary finger (not the end of a pan or a two-finger gesture).
type TouchGesture = { startX: number; startY: number; multi: boolean; moved: boolean };
const TAP_SLOP_PX = 10;
// Browsers can follow a tap with emulated mouse events; ignore a click this
// soon after a tap so the hit-test does not run twice.
const TAP_CLICK_DEDUPE_MS = 800;

// "seed:<id>" | "cambium:<id>", the format both the planting guide (?open=)
// and the harvest log (?seed=) accept. Personal seed wins.
function seedParam(planting: Planting): string | null {
  if (planting.seedId) return `seed:${planting.seedId}`;
  if (planting.cambiumSeedId) return `cambium:${planting.cambiumSeedId}`;
  return null;
}

const popoverButtonStyle: CSSProperties = {
  minHeight: 44, minWidth: 44, padding: '0 var(--sp-3)', borderRadius: 'var(--r-md)',
  fontSize: 13, fontFamily: 'inherit', cursor: 'pointer',
};

const popoverLinkStyle: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', minHeight: 44, minWidth: 44,
  color: 'var(--c-primary)', fontSize: 13, fontWeight: 600, textDecoration: 'underline',
};

// ---- Pure helpers ----

// Space on a focused control (or anything inside a dialog) belongs to that
// control, not to Space-to-pan.
function spaceTargetsControl(active: Element | null): boolean {
  const el = active as HTMLElement | null;
  if (!el) return false;
  return el.tagName === 'BUTTON' || el.tagName === 'A' || el.tagName === 'INPUT'
    || el.tagName === 'TEXTAREA' || el.isContentEditable
    || el.closest('[role="dialog"]') !== null;
}

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

// Inner cell lines of a grid bed, in the bed's local coords.
function gridCellLines(cols: number, rows: number, stroke: string): ReactNode[] {
  const bw = cols * GRID_PX;
  const bh = rows * GRID_PX;
  const lines: ReactNode[] = [];
  for (let col = 1; col < cols; col++) {
    lines.push(<Line key={`vc${col}`} points={[col * GRID_PX, 0, col * GRID_PX, bh]} stroke={stroke} strokeWidth={0.5} />);
  }
  for (let row = 1; row < rows; row++) {
    lines.push(<Line key={`hr${row}`} points={[0, row * GRID_PX, bw, row * GRID_PX]} stroke={stroke} strokeWidth={0.5} />);
  }
  return lines;
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

// ---- Planting marker ----

interface PlantingMarkerProps {
  planting: Planting;
  x: number;
  y: number;
  scale: number;
  conflicted?: boolean;
  // Plain markers (e.g. a past-season overlay): no label, stage mark, harvest
  // treatment, companion ring or animation refs; fill/opacity from the caller.
  plain?: { fill: string; opacity: number };
  // Stable registry from the parent; called with null on unmount.
  registerRef?: (kind: MarkerRefKind, id: string, node: Konva.Node | null) => void;
}

type MarkerRefKind = 'group' | 'circle' | 'ring' | 'brightness';

// Drawn centred on a Group at (x, y) so entrance tweens scale about the
// marker's centre. Visual only: hit-testing stays in JS.
// Memoised: during a bed drag only the moving bed's markers get new props,
// so the rest skip render and keep their ref callbacks.
const PlantingMarker = memo(function PlantingMarker({
  planting, x, y, scale, conflicted, plain, registerRef,
}: PlantingMarkerProps) {
  const id = planting.id;
  const groupRef = useCallback((n: Konva.Group | null) => registerRef?.('group', id, n), [registerRef, id]);
  const circleRef = useCallback((n: Konva.Circle | null) => registerRef?.('circle', id, n), [registerRef, id]);
  const ringRef = useCallback((n: Konva.Circle | null) => registerRef?.('ring', id, n), [registerRef, id]);
  const brightnessRef = useCallback((n: Konva.Circle | null) => registerRef?.('brightness', id, n), [registerRef, id]);
  const stage = planting.growth.stage;
  const sceneFunc = useCallback((ctx: Konva.Context) => {
    if (stage !== null) drawStageMark(ctx, stage, MARKER_RADIUS);
  }, [stage]);

  if (plain) {
    return (
      <Group x={x} y={y} listening={false}>
        <Circle radius={MARKER_RADIUS} fill={plain.fill} opacity={plain.opacity} />
      </Group>
    );
  }

  const seedId = planting.cambiumSeedId ?? planting.seedId ?? planting.id;
  const color = markerColor(seedId);
  const tier = markerTier(2 * MARKER_RADIUS * scale);
  const ready = isHarvestReady(planting);
  const { anchored } = planting.growth;
  const showMark = tier === 'large' && anchored && stage !== null;
  const showLabel = tier === 'medium' || (tier === 'large' && !showMark);
  const showHarvest = ready && tier !== 'small';
  // Markers are drawn in world units inside the scaled stage, so the harvest
  // ring's on-screen px (2 px inset, 2.5 px stroke) are divided by scale.
  const px = 1 / scale;

  return (
    <Group ref={groupRef} x={x} y={y} listening={false}>
      <Circle
        ref={circleRef}
        radius={MARKER_RADIUS}
        fill={tier === 'small' && ready ? '#E6B85C' : color}
        opacity={0.88}
      />
      {showHarvest && (
        <>
          <Circle radius={MARKER_RADIUS} fill="rgba(230, 184, 92, 0.10)" listening={false} />
          <Circle ref={brightnessRef} radius={MARKER_RADIUS} fill="#fff" opacity={0.12} listening={false} />
          <Circle
            radius={MARKER_RADIUS - 2 * px}
            stroke="#E6B85C"
            strokeWidth={2.5 * px}
            opacity={0.68}
            listening={false}
          />
        </>
      )}
      {conflicted && (
        <Circle
          ref={ringRef}
          radius={MARKER_RADIUS + 3}
          fill="transparent"
          stroke="#C88A2A"
          strokeWidth={2}
          listening={false}
        />
      )}
      {showMark && (
        <Shape sceneFunc={sceneFunc} listening={false} />
      )}
      {showLabel && (
        <Text
          text={markerLabel(planting)}
          x={-MARKER_RADIUS}
          y={-5}
          width={MARKER_RADIUS * 2}
          fontSize={8}
          align="center"
          fill="#fff"
          fontStyle="bold"
          listening={false}
        />
      )}
    </Group>
  );
});

// ---- Past-season overlay bed ----

// Same geometry as the bed layer (grid rect + cell lines / freeform polygon),
// tinted, with no label, selection, conflict or drag state. Visual only.
const OverlayBed = memo(function OverlayBed({ bed }: { bed: Bed }) {
  if (bed.type === 'grid' && bed.grid) {
    const { x, y, cols, rows } = bed.grid;
    return (
      <Group x={x * GRID_PX} y={y * GRID_PX} opacity={OVERLAY_OPACITY} listening={false}>
        <Rect width={cols * GRID_PX} height={rows * GRID_PX}
          fill={OVERLAY_TINT} stroke={OVERLAY_TINT} strokeWidth={1.5} cornerRadius={2} />
        {gridCellLines(cols, rows, OVERLAY_TINT)}
      </Group>
    );
  }
  if (bed.type === 'freeform' && bed.freeform) {
    return (
      <Group opacity={OVERLAY_OPACITY} listening={false}>
        <Line points={bed.freeform.points} closed={bed.freeform.closed}
          fill={OVERLAY_TINT} stroke={OVERLAY_TINT} strokeWidth={1.5} dash={[6, 4]} />
      </Group>
    );
  }
  return null;
});

// ---- Component ----

const GardenCanvas = forwardRef<GardenCanvasRef, Props>(({
  beds, selectedBedId, onSelectBed, onDoubleBed,
  onCreateBed, onUpdateBedGeometry,
  onScaleChange, onOverlapWarning, mode, panActive, gardenId,
  garden, plantingsByBedId, plantingsLoading, armedSeed,
  onConfirmPlacement, onConfirmRemoval, onMarkHarvested,
  // Phase 20
  conflictedIds, conflictedBedIds, latestPlacing,
  occupancyByBedId, relationshipBetween,
  plantingsLoadedKey, onStagesDisplayed,
  overlayBeds = EMPTY_BEDS, overlayPlantingsByBedId = EMPTY_PLANTINGS,
  bedsLoadedKey,
}, ref) => {
  useRegisterCanvas();
  const stageRef = useRef<Konva.Stage>(null);
  const [scale, setScale] = useState(1);
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [spaceHeld, setSpaceHeld] = useState(false);

  // Grid creation
  const gridDragRef = useRef<{ startCell: { cellX: number; cellY: number }; startWorld: { x: number; y: number }; curCell: { cellX: number; cellY: number }; moved: boolean } | null>(null);
  const [gridPreview, setGridPreview] = useState<{ x: number; y: number; cols: number; rows: number; overlap: boolean } | null>(null);
  const gridPreviewRef = useRef<{ x: number; y: number; cols: number; rows: number; overlap: boolean } | null>(null);
  const setGridPreviewSynced = useCallback((v: { x: number; y: number; cols: number; rows: number; overlap: boolean } | null) => {
    gridPreviewRef.current = v;
    setGridPreview(v);
  }, []);

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

  const markerCircleRefs = useRef<Map<string, Konva.Circle>>(new Map());
  const ringCircleRefs = useRef<Map<string, Konva.Circle>>(new Map());
  const markerGroupRefs = useRef<Map<string, Konva.Group>>(new Map());
  const brightnessCircleRefs = useRef<Map<string, Konva.Circle>>(new Map());
  const registerMarkerRef = useCallback((kind: MarkerRefKind, id: string, node: Konva.Node | null) => {
    const map: Map<string, Konva.Node> =
      kind === 'group' ? markerGroupRefs.current
        : kind === 'circle' ? markerCircleRefs.current
          : kind === 'ring' ? ringCircleRefs.current
            : brightnessCircleRefs.current;
    if (node) map.set(id, node);
    else map.delete(id);
  }, []);

  const setFreeformPtsSynced = useCallback((pts: number[]) => {
    freeformPtsRef.current = pts;
    setFreeformPts(pts);
  }, []);

  // Phase 19: placement popover
  const [pendingPlacement, setPendingPlacement] = useState<PendingPlacement | null>(null);
  const pendingPlacementRef = useRef<PendingPlacement | null>(null);
  const setPendingPlacementSynced = useCallback((v: PendingPlacement | null) => {
    pendingPlacementRef.current = v;
    setPendingPlacement(v);
  }, []);
  const [placementQty, setPlacementQty] = useState(1);
  const [placementDate, setPlacementDate] = useState('');

  // Phase 50: inspection popover (replaces the removal popover)
  const isMobile = useIsMobile();
  const [pendingInspect, setPendingInspect] = useState<PendingInspect | null>(null);
  const pendingInspectRef = useRef<PendingInspect | null>(null);
  const [harvestBusy, setHarvestBusy] = useState(false);
  const [harvestError, setHarvestError] = useState<string | null>(null);
  const setPendingInspectSynced = useCallback((v: PendingInspect | null) => {
    pendingInspectRef.current = v;
    setPendingInspect(v);
    setHarvestBusy(false);
    setHarvestError(null);
  }, []);
  const inspectPopoverRef = useRef<HTMLDivElement>(null);
  const [inspectH, setInspectH] = useState(150);
  const touchGestureRef = useRef<TouchGesture | null>(null);
  const lastTapAtRef = useRef(0);

  // Phase 53: mobile is view-only. No bed placement, drawing, move, resize or
  // plant placement/removal handlers run; taps inspect, drags pan, pinch zooms.
  const isMobileRef = useRef(isMobile);
  isMobileRef.current = isMobile;
  const [pendingBed, setPendingBed] = useState<PendingBedInspect | null>(null);
  const pendingBedRef = useRef<PendingBedInspect | null>(null);
  const setPendingBedSynced = useCallback((v: PendingBedInspect | null) => {
    pendingBedRef.current = v;
    setPendingBed(v);
  }, []);
  const bedPopoverRef = useRef<HTMLDivElement>(null);
  const [bedPopH, setBedPopH] = useState(110);
  // Fixed probe spanning the area between the shell bars, so fitting frames
  // the beds in what is actually visible (the stage runs under the bars).
  const insetProbeRef = useRef<HTMLDivElement>(null);
  // Scale chosen by the last fitToBeds; on mobile it is the minimum zoom.
  const fittedScaleRef = useRef(1);
  const lastPressRef = useRef<{ t: number; x: number; y: number } | null>(null);
  const pressTimerRef = useRef<number | null>(null);
  const stageTweenRef = useRef<Konva.Tween | null>(null);
  const pinchRef = useRef<{ dist: number; center: { x: number; y: number } } | null>(null);

  const getMinScale = useCallback(
    () => (isMobileRef.current ? Math.min(fittedScaleRef.current, 1) : MIN_SCALE),
    [],
  );

  const cancelPendingPress = useCallback(() => {
    if (pressTimerRef.current !== null) {
      window.clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
  }, []);
  useEffect(() => () => {
    if (pressTimerRef.current !== null) window.clearTimeout(pressTimerRef.current);
    stageTweenRef.current?.destroy();
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
        if (spaceTargetsControl(document.activeElement)) return;
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
        setGridPreviewSynced(null);
        gridDragRef.current = null;
        moveRef.current = null;
        setDragOffsetSynced(null);
        setMoveOverlapSynced(false);
        resizeRef.current = null;
        setResizePreviewSynced(null);
        setPendingPlacementSynced(null);
        setPendingInspectSynced(null);
        setPendingBedSynced(null);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        if (spaceTargetsControl(document.activeElement)) return;
        setSpaceHeld(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => { window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp); };
  }, [setFreeformPtsSynced, setDragOffsetSynced, setResizePreviewSynced, setMoveOverlapSynced, setPendingPlacementSynced, setPendingInspectSynced, setPendingBedSynced]);

  // Inspection / bed popover: a pointerdown outside it closes it. Presses on
  // the canvas are left to handleClick, which already closes popovers on click.
  const popoverOpen = pendingInspect != null || pendingBed != null;
  useEffect(() => {
    if (!popoverOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (inspectPopoverRef.current?.contains(target)) return;
      if (bedPopoverRef.current?.contains(target)) return;
      if (stageRef.current?.container().contains(target)) return;
      setPendingInspectSynced(null);
      setPendingBedSynced(null);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [popoverOpen, setPendingInspectSynced, setPendingBedSynced]);

  // Measure the inspection popover so edge-flipping uses its real height.
  // Re-measures when it opens for a planting or that planting changes
  // (e.g. "Mark as harvested" removes the button), or the error toggles.
  const inspectedPlanting = pendingInspect
    ? (plantingsByBedId[pendingInspect.bedId] ?? []).find(p => p.id === pendingInspect.plantingId) ?? null
    : null;
  useLayoutEffect(() => {
    const el = inspectPopoverRef.current;
    if (el && el.offsetHeight !== inspectH) setInspectH(el.offsetHeight);
  }, [inspectedPlanting, harvestError, harvestBusy, isMobile, inspectH]);

  const inspectedBed = pendingBed ? beds.find(b => b.id === pendingBed.bedId) ?? null : null;
  useLayoutEffect(() => {
    const el = bedPopoverRef.current;
    if (el && el.offsetHeight !== bedPopH) setBedPopH(el.offsetHeight);
  }, [inspectedBed, plantingsByBedId, bedPopH]);
  // A bed that disappears (e.g. deleted elsewhere) closes its popover.
  useEffect(() => {
    if (pendingBed && !inspectedBed) setPendingBedSynced(null);
  }, [pendingBed, inspectedBed, setPendingBedSynced]);
  // Focus the bed popover when it opens; on close (X, Escape, outside tap,
  // pan/zoom) hand focus back to the canvas container, as the plant popover does.
  const inspectedBedId = inspectedBed?.id ?? null;
  const hadBedPopoverRef = useRef(false);
  useEffect(() => {
    if (inspectedBedId) {
      hadBedPopoverRef.current = true;
      bedPopoverRef.current?.focus({ preventScroll: true });
      return;
    }
    if (!hadBedPopoverRef.current) return;
    hadBedPopoverRef.current = false;
    if (pendingInspectRef.current) return; // the plant popover took over
    const container = stageRef.current?.container();
    if (container && container.tabIndex >= 0) container.focus({ preventScroll: true });
  }, [inspectedBedId]);

  // Focus the popover when it opens for a new planting; on close, hand focus
  // back to the canvas container if it can take it.
  const inspectedId = pendingInspect?.plantingId ?? null;
  const hadInspectRef = useRef(false);
  useEffect(() => {
    if (inspectedId) {
      hadInspectRef.current = true;
      inspectPopoverRef.current?.focus({ preventScroll: true });
      return;
    }
    if (!hadInspectRef.current) return;
    hadInspectRef.current = false;
    if (pendingBedRef.current) return; // the bed popover took over
    const container = stageRef.current?.container();
    if (container && container.tabIndex >= 0) container.focus({ preventScroll: true });
  }, [inspectedId]);

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

  // Every marker tween runs through tweenTo so a garden/season switch or
  // unmount can destroy chains still in flight; each step re-checks that its
  // node is still on a layer before chaining the next.
  const tweensRef = useRef<Set<Konva.Tween>>(new Set());
  const tweenTo = useCallback((
    node: Konva.Node,
    config: { duration: number; easing?: (t: number, b: number, c: number, d: number) => number; [attr: string]: unknown },
    onFinish?: () => void,
  ) => {
    const tween: Konva.Tween = new Konva.Tween({
      ...config,
      node,
      onFinish: () => {
        tweensRef.current.delete(tween);
        tween.destroy();
        if (!node.getLayer()) return;
        onFinish?.();
      },
    });
    tweensRef.current.add(tween);
    tween.play();
  }, []);

  useLayoutEffect(() => {
    const tweens = tweensRef.current;
    return () => {
      for (const tween of tweens) tween.destroy();
      tweens.clear();
    };
  }, [gardenId, plantingsLoadedKey]);

  // Phase 20: conflict pulse
  const prevConflictedIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    // Phase 53: rings still render on mobile, but they never pulse there.
    if (REDUCED_MOTION || isMobileRef.current) {
      prevConflictedIdsRef.current = new Set(conflictedIds);
      return;
    }
    const prev = prevConflictedIdsRef.current;
    const newConflicts = conflictedIds
      ? [...conflictedIds].filter(id => !prev.has(id))
      : [];
    for (const id of newConflicts) {
      const node = markerCircleRefs.current.get(id);
      if (!node) continue;
      tweenTo(node, { scaleX: 1.15, scaleY: 1.15, duration: 0.4 }, () =>
        tweenTo(node, { scaleX: 1, scaleY: 1, duration: 0.4 }, () =>
          tweenTo(node, { scaleX: 1.15, scaleY: 1.15, duration: 0.4 }, () =>
            tweenTo(node, { scaleX: 1, scaleY: 1, duration: 0.4 }))));
    }
    prevConflictedIdsRef.current = new Set(conflictedIds);
  }, [conflictedIds, tweenTo]);

  // Phase 20: beneficial pulse
  useEffect(() => {
    if (!latestPlacing || REDUCED_MOTION) return;
    const { id } = latestPlacing;
    // Skip if this planting is in a conflict (conflict ring dominates)
    if (conflictedIds?.has(id)) return;
    // Check if new planting has any beneficial adjacency
    if (!relationshipBetween) return;
    const planting = Object.values(plantingsByBedIdRef.current).flat().find(p => p.id === id);
    if (!planting) return;
    const bed = bedsRef.current.find(b => b.id === planting.bedId);
    if (!bed || !planting.companionSeedId) return;
    const bedPlantings = plantingsByBedIdRef.current[planting.bedId] ?? [];
    let hasBeneficial = false;
    for (const other of bedPlantings) {
      if (other.id === id || !other.companionSeedId) continue;
      if (relationshipBetween(planting.companionSeedId, other.companionSeedId) === 'beneficial') {
        hasBeneficial = true;
        break;
      }
    }
    if (!hasBeneficial) return;
    const node = markerCircleRefs.current.get(id);
    if (!node) return;
    tweenTo(node, { scaleX: 1.12, scaleY: 1.12, duration: 0.4 }, () =>
      tweenTo(node, { scaleX: 1, scaleY: 1, duration: 0.4 }));
  }, [latestPlacing, conflictedIds, relationshipBetween, tweenTo]);

  // Phase 50: on load (once per garden + season), show plantings whose stage
  // changed since last seen: a harvest pulse for stage 5 harvest-ready, an
  // entrance otherwise. Then record them as displayed. Layout effect so the
  // entrance's starting opacity is set before the first paint.
  const stageShownKeysRef = useRef<Set<string>>(new Set());
  useLayoutEffect(() => {
    const key = plantingsLoadedKey;
    // Wait for this garden's beds too: markers only exist once both landed.
    if (!key || !key.startsWith(`${gardenId}:`) || garden?.id !== gardenId) return;
    if (stageShownKeysRef.current.has(key)) return; // StrictMode re-run / reload
    // The key is spent here on purpose, even if no marker is drawn yet (e.g.
    // its bed hasn't rendered): those plantings stay unpatched and animate on
    // a later garden/season load, never replayed within this one.
    stageShownKeysRef.current.add(key);

    const shown: string[] = [];
    for (const planting of Object.values(plantingsByBedIdRef.current).flat()) {
      const { anchored, stage, displayedStage } = planting.growth;
      if (!anchored || stage === displayedStage) continue;
      const group = markerGroupRefs.current.get(planting.id);
      if (!group) continue; // not drawn, so not seen
      shown.push(planting.id);

      if (stage === 5 && isHarvestReady(planting)) {
        // No brightness circle at the smallest tier; then there is no pulse.
        const glow = brightnessCircleRefs.current.get(planting.id);
        if (!glow || REDUCED_MOTION) continue;
        const pulse = (remaining: number) =>
          tweenTo(glow, { opacity: 0.24, duration: 0.8, easing: Konva.Easings.EaseInOut }, () =>
            tweenTo(glow, { opacity: 0.12, duration: 0.8, easing: Konva.Easings.EaseInOut }, () => {
              if (remaining > 1) pulse(remaining - 1);
            }));
        pulse(2);
      } else {
        group.opacity(0);
        if (!REDUCED_MOTION) group.scale({ x: 0.86, y: 0.86 });
        tweenTo(group, {
          opacity: 1,
          ...(REDUCED_MOTION ? {} : { scaleX: 1, scaleY: 1 }),
          duration: 0.4,
          easing: Konva.Easings.EaseOut,
        });
      }
    }
    // Deferred so the state update it triggers lands outside the layout effect.
    if (shown.length > 0) queueMicrotask(() => onStagesDisplayed?.(shown));
  }, [plantingsLoadedKey, gardenId, garden?.id, onStagesDisplayed, tweenTo]);

  // [ring-diag] observe conflictedIds prop as it reaches the canvas
  useEffect(() => {
    console.log('[ring-diag][canvas] conflictedIds prop', {
      size: conflictedIds?.size ?? 0,
      ids: conflictedIds ? [...conflictedIds] : null,
    });
  }, [conflictedIds]);

  const applyZoom = useCallback((newScale: number, cx: number, cy: number) => {
    // Popovers are anchored to screen positions; close them rather than drift.
    setPendingPlacementSynced(null);
    setPendingInspectSynced(null);
    setPendingBedSynced(null);
    cancelPendingPress();
    const stage = stageRef.current;
    if (!stage) return;
    stageTweenRef.current?.destroy();
    stageTweenRef.current = null;
    const clamped = Math.min(Math.max(newScale, getMinScale()), MAX_SCALE);
    const old = stage.scaleX();
    const pt = { x: (cx - stage.x()) / old, y: (cy - stage.y()) / old };
    stage.scale({ x: clamped, y: clamped });
    stage.position({ x: cx - pt.x * clamped, y: cy - pt.y * clamped });
    stage.batchDraw();
    setScale(clamped);
    onScaleChange?.(clamped);
  }, [onScaleChange, setPendingPlacementSynced, setPendingInspectSynced, setPendingBedSynced, cancelPendingPress, getMinScale]);

  // Phase 53: move the stage to a scale + position, tweened over `durationS`
  // unless reduced motion is on (or duration is 0). Scale state commits at the end.
  const moveStageTo = useCallback((target: number, x: number, y: number, durationS: number) => {
    const stage = stageRef.current;
    if (!stage) return;
    stageTweenRef.current?.destroy();
    stageTweenRef.current = null;
    const commit = () => {
      setScale(target);
      onScaleChange?.(target);
    };
    if (durationS <= 0 || REDUCED_MOTION) {
      stage.scale({ x: target, y: target });
      stage.position({ x, y });
      stage.batchDraw();
      commit();
      return;
    }
    const tween: Konva.Tween = new Konva.Tween({
      node: stage,
      duration: durationS,
      easing: Konva.Easings.EaseInOut,
      scaleX: target,
      scaleY: target,
      x,
      y,
      onFinish: () => {
        if (stageTweenRef.current === tween) stageTweenRef.current = null;
        tween.destroy();
        commit();
      },
    });
    stageTweenRef.current = tween;
    tween.play();
  }, [onScaleChange]);

  // The stage area between the shell bars, in stage (container) coordinates.
  const visibleRect = useCallback(() => {
    const stage = stageRef.current;
    const w = stage?.width() ?? window.innerWidth;
    const h = stage?.height() ?? window.innerHeight;
    const probe = insetProbeRef.current;
    const container = stage?.container();
    if (!probe || !container) return { x: 0, y: 0, w, h };
    const pr = probe.getBoundingClientRect();
    const cr = container.getBoundingClientRect();
    const top = Math.min(Math.max(0, pr.top - cr.top), h);
    const bottom = Math.max(top, Math.min(h, pr.bottom - cr.top));
    return bottom - top > 2 * FIT_MARGIN_PX ? { x: 0, y: top, w, h: bottom - top } : { x: 0, y: 0, w, h };
  }, []);

  // Phase 53: frame every current-season bed (grid rects and freeform
  // polygons) with a FIT_MARGIN_PX margin, scale capped at 1, centred. No
  // beds: scale 1 at the origin. On mobile the fitted scale is the minimum zoom.
  const fitToBeds = useCallback((durationS = 0) => {
    const stage = stageRef.current;
    if (!stage) return;
    setPendingPlacementSynced(null);
    setPendingInspectSynced(null);
    setPendingBedSynced(null);
    cancelPendingPress();
    const view = visibleRect();
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const bed of bedsRef.current) {
      const bb = getBedBbox(bed);
      if (!bb) continue;
      x1 = Math.min(x1, bb.x1); y1 = Math.min(y1, bb.y1);
      x2 = Math.max(x2, bb.x2); y2 = Math.max(y2, bb.y2);
    }
    if (!(x2 >= x1) || !(y2 >= y1)) {
      fittedScaleRef.current = 1;
      // Desktop: the strict origin, as before. Mobile: the visible band's
      // top-left, so the origin isn't under the top bar.
      if (isMobileRef.current) moveStageTo(1, view.x, view.y, durationS);
      else moveStageTo(1, 0, 0, durationS);
      return;
    }
    const bw = Math.max(x2 - x1, 1);
    const bh = Math.max(y2 - y1, 1);
    const availW = Math.max(view.w - 2 * FIT_MARGIN_PX, 1);
    const availH = Math.max(view.h - 2 * FIT_MARGIN_PX, 1);
    let fitted = Math.min(availW / bw, availH / bh, 1);
    // Desktop keeps its 0.2 floor; on mobile the fit itself is the floor.
    if (!isMobileRef.current) fitted = Math.max(fitted, MIN_SCALE);
    fittedScaleRef.current = fitted;
    const cx = (x1 + x2) / 2;
    const cy = (y1 + y2) / 2;
    moveStageTo(
      fitted,
      view.x + view.w / 2 - cx * fitted,
      view.y + view.h / 2 - cy * fitted,
      durationS,
    );
  }, [visibleRect, moveStageTo, setPendingPlacementSynced, setPendingInspectSynced, setPendingBedSynced, cancelPendingPress]);

  // Fit once per completed beds load (garden open or season switch), never on
  // bed edits. Waits for the beds to belong to gardenId.
  const fittedKeyRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!bedsLoadedKey || !bedsLoadedKey.startsWith(`${gardenId}:`) || garden?.id !== gardenId) return;
    if (fittedKeyRef.current === bedsLoadedKey) return;
    if (!stageRef.current) return;
    fittedKeyRef.current = bedsLoadedKey;
    fitToBeds();
  }, [bedsLoadedKey, gardenId, garden?.id, fitToBeds]);

  // Refit when crossing the mobile breakpoint, so the mobile minimum zoom is
  // the fit without the desktop 0.2 floor (and the current scale is never
  // below it). Only once the current garden's beds have been fitted.
  const prevIsMobileRef = useRef(isMobile);
  useEffect(() => {
    if (prevIsMobileRef.current === isMobile) return;
    prevIsMobileRef.current = isMobile;
    if (fittedKeyRef.current == null || fittedKeyRef.current !== bedsLoadedKey) return;
    // Next frame: the shell bars (--shell-top/--shell-bottom, set by a parent
    // layout effect) and the stage size have settled by then.
    // (Not cancelled on re-run: the ref above already consumed this change;
    // fitToBeds no-ops if the stage is gone.)
    window.requestAnimationFrame(() => fitToBeds());
  }, [isMobile, bedsLoadedKey, fitToBeds]);

  // Mobile double-tap: zoomed in past the fit → back to the fit; otherwise
  // zoom to 2x the fitted scale centred on the tap. Decided by the current
  // scale, so pinches and button zooms in between are respected.
  const doubleTapZoom = useCallback((p: { x: number; y: number }) => {
    const stage = stageRef.current;
    if (!stage) return;
    if (stage.scaleX() > fittedScaleRef.current * 1.01) {
      fitToBeds(DOUBLE_TAP_ANIM_S);
      return;
    }
    setPendingInspectSynced(null);
    setPendingBedSynced(null);
    const target = Math.min(Math.max(fittedScaleRef.current * 2, getMinScale()), MAX_SCALE);
    const w = stage.getAbsoluteTransform().copy().invert().point(p);
    const view = visibleRect();
    moveStageTo(
      target,
      view.x + view.w / 2 - w.x * target,
      view.y + view.h / 2 - w.y * target,
      DOUBLE_TAP_ANIM_S,
    );
  }, [fitToBeds, getMinScale, visibleRect, moveStageTo, setPendingInspectSynced, setPendingBedSynced]);

  // ---- Phase 41: thumbnail capture ----

  // Renders only the thumb-* layers (beds, markers, labels), framed on their
  // content, to a PNG whose long side is THUMB_LONG_SIDE_PX. Never throws.
  const captureThumbnail = useCallback((): Promise<Blob | null> => {
    const stage = stageRef.current;
    if (!stage || bedsRef.current.length === 0) return Promise.resolve(null);

    const hidden: Konva.Layer[] = [];
    const restore = () => {
      for (const layer of hidden) layer.visible(true);
      hidden.length = 0;
    };

    try {
      const thumbLayers: Konva.Layer[] = [];
      for (const layer of stage.getLayers()) {
        if (layer.name().startsWith('thumb-')) {
          thumbLayers.push(layer);
        } else if (layer.visible()) {
          layer.visible(false);
          hidden.push(layer);
        }
      }

      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
      for (const layer of thumbLayers) {
        const r = layer.getClientRect();
        // An empty layer (e.g. no plantings) reports a 0×0 rect at the origin.
        if (r.width === 0 && r.height === 0) continue;
        x1 = Math.min(x1, r.x);
        y1 = Math.min(y1, r.y);
        x2 = Math.max(x2, r.x + r.width);
        y2 = Math.max(y2, r.y + r.height);
      }
      if (!(x2 - x1 > 0) || !(y2 - y1 > 0)) {
        restore();
        return Promise.resolve(null);
      }

      const box = {
        x: x1 - THUMB_PAD,
        y: y1 - THUMB_PAD,
        width: x2 - x1 + THUMB_PAD * 2,
        height: y2 - y1 + THUMB_PAD * 2,
      };
      const pixelRatio = THUMB_LONG_SIDE_PX / Math.max(box.width, box.height);
      const canvas = stage.toCanvas({ ...box, pixelRatio });
      restore();

      return new Promise(resolve => {
        try {
          canvas.toBlob(blob => resolve(blob), 'image/png');
        } catch {
          resolve(null);
        }
      });
    } catch {
      restore();
      return Promise.resolve(null);
    }
  }, []);

  const captureAndUpload = useCallback((targetGardenId: string) => {
    captureThumbnail()
      .then(blob => {
        if (!blob) return;
        return fetch(apiUrl(`/api/gardens/${targetGardenId}/thumbnail`), {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'image/png' },
          body: blob,
        });
      })
      .catch(() => {});
  }, [captureThumbnail]);

  // Current-season content the thumbnail depicts. Selection, previews and
  // overlays are deliberately excluded.
  const thumbSignature = useMemo(() => JSON.stringify([
    beds.map(b => [b.id, b.type, b.label, b.grid, b.freeform]),
    beds.map(b => (plantingsByBedId[b.id] ?? []).map(p => [p.id, p.cell, p.point])),
  ]), [beds, plantingsByBedId]);

  // useGarden/usePlantings keep the previous garden's data until the new
  // fetches land, so "loaded" means both belong to gardenId.
  const thumbContentLoaded = gardenId !== '' && garden?.id === gardenId && !plantingsLoading;

  const thumbTimerRef = useRef<number | null>(null);
  const thumbPendingRef = useRef(false);
  const thumbLastSigRef = useRef<string | null>(null);

  // Per garden: forget the baseline. Cleanup runs on garden switch and on
  // unmount (layout cleanup, so the Stage still exists) and flushes a
  // pending capture for the garden that is still drawn.
  useLayoutEffect(() => {
    thumbLastSigRef.current = null;
    return () => {
      if (thumbTimerRef.current !== null) {
        window.clearTimeout(thumbTimerRef.current);
        thumbTimerRef.current = null;
      }
      if (thumbPendingRef.current) {
        thumbPendingRef.current = false;
        if (gardenId && stageRef.current) captureAndUpload(gardenId);
      }
    };
  }, [gardenId, captureAndUpload]);

  useEffect(() => {
    if (!thumbContentLoaded) return;
    if (thumbLastSigRef.current === null) {
      thumbLastSigRef.current = thumbSignature; // baseline: opening a garden never captures
      return;
    }
    if (thumbSignature === thumbLastSigRef.current) return;
    thumbLastSigRef.current = thumbSignature;
    thumbPendingRef.current = true;
    if (thumbTimerRef.current !== null) window.clearTimeout(thumbTimerRef.current);
    const targetGardenId = gardenId;
    thumbTimerRef.current = window.setTimeout(() => {
      thumbTimerRef.current = null;
      thumbPendingRef.current = false;
      captureAndUpload(targetGardenId);
    }, THUMB_DEBOUNCE_MS);
  }, [thumbContentLoaded, thumbSignature, gardenId, captureAndUpload]);

  // Button zoom pivot: the stage centre on desktop (unchanged); on mobile the
  // centre of the visible band between the shell bars.
  const zoomPivot = useCallback((s: Konva.Stage) => {
    if (!isMobileRef.current) return { x: s.width() / 2, y: s.height() / 2 };
    const view = visibleRect();
    return { x: view.x + view.w / 2, y: view.y + view.h / 2 };
  }, [visibleRect]);

  useImperativeHandle(ref, () => ({
    captureThumbnail,
    fitToBeds() { fitToBeds(); },
    zoomIn() {
      const s = stageRef.current; if (!s) return;
      const c = zoomPivot(s);
      applyZoom(s.scaleX() * ZOOM_STEP, c.x, c.y);
    },
    zoomOut() {
      const s = stageRef.current; if (!s) return;
      const c = zoomPivot(s);
      applyZoom(s.scaleX() / ZOOM_STEP, c.x, c.y);
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
  }), [applyZoom, onScaleChange, captureThumbnail, fitToBeds, zoomPivot]);

  const handleWheel = useCallback((e: Konva.KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault();
    const stage = stageRef.current; if (!stage) return;
    const pointer = stage.getPointerPosition(); if (!pointer) return;
    const newScale = e.evt.deltaY < 0 ? stage.scaleX() * ZOOM_STEP : stage.scaleX() / ZOOM_STEP;
    applyZoom(newScale, pointer.x, pointer.y);
  }, [applyZoom]);

  const handleMouseDown = useCallback((e: Konva.KonvaEventObject<MouseEvent>) => {
    if (isMobileRef.current) return; // view-only: no resize, move or drawing
    if ('button' in e.evt && (e.evt as unknown as MouseEvent).button !== 0) return;
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
    if (isMobileRef.current) return;
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
        setGridPreviewSynced({ ...g, overlap });
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

  const handleMouseUp = useCallback((_e?: Konva.KonvaEventObject<MouseEvent>) => {
    if (isMobileRef.current) return;
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
        const preview = gridPreviewRef.current;
        setGridPreviewSynced(null);
        if (preview && !preview.overlap) {
          onCreateBed({ type: 'grid', label: `Bed ${bedsRef.current.length + 1}`, grid: { x: preview.x, y: preview.y, cols: preview.cols, rows: preview.rows } });
        } else if (preview?.overlap) {
          onOverlapWarning?.("Beds can't overlap");
        }
        return;
      }
      setGridPreviewSynced(null);
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
  }, [onCreateBed, onUpdateBedGeometry, onOverlapWarning, setDragOffsetSynced, setMoveOverlapSynced, setResizePreviewSynced]);

  const handleTouchStart = useCallback((e: Konva.KonvaEventObject<TouchEvent>) => {
    const touches = e.evt.touches;
    if (touches.length === 1) {
      touchGestureRef.current = { startX: touches[0].clientX, startY: touches[0].clientY, multi: false, moved: false };
    } else {
      touchGestureRef.current = { startX: 0, startY: 0, multi: true, moved: false };
      if (isMobileRef.current) {
        // A second finger starts a pinch: no pending tap, no open popover.
        cancelPendingPress();
        lastPressRef.current = null;
        pinchRef.current = null;
        setPendingInspectSynced(null);
        setPendingBedSynced(null);
      }
    }
    handleMouseDown(e as unknown as Konva.KonvaEventObject<MouseEvent>);
  }, [handleMouseDown, cancelPendingPress, setPendingInspectSynced, setPendingBedSynced]);

  // Phase 53: mobile pinch-zoom about the pinch centre (with two-finger pan),
  // clamped to the mobile minimum (the fitted scale) and MAX_SCALE. Scale
  // state commits when the pinch ends so markers don't re-render per move.
  const handlePinchMove = useCallback((evt: TouchEvent) => {
    const stage = stageRef.current;
    if (!stage || evt.touches.length < 2) return;
    evt.preventDefault();
    if (stage.isDragging()) stage.stopDrag();
    stageTweenRef.current?.destroy();
    stageTweenRef.current = null;
    const rect = stage.container().getBoundingClientRect();
    const a = { x: evt.touches[0].clientX - rect.left, y: evt.touches[0].clientY - rect.top };
    const b = { x: evt.touches[1].clientX - rect.left, y: evt.touches[1].clientY - rect.top };
    const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const last = pinchRef.current;
    pinchRef.current = { dist, center };
    if (!last || last.dist === 0) return;
    const old = stage.scaleX();
    const next = Math.min(Math.max(old * (dist / last.dist), getMinScale()), MAX_SCALE);
    const pt = { x: (last.center.x - stage.x()) / old, y: (last.center.y - stage.y()) / old };
    stage.scale({ x: next, y: next });
    stage.position({ x: center.x - pt.x * next, y: center.y - pt.y * next });
    stage.batchDraw();
  }, [getMinScale]);

  const handleTouchMove = useCallback((e: Konva.KonvaEventObject<TouchEvent>) => {
    const g = touchGestureRef.current;
    const t = e.evt.touches[0];
    if (g && t && !g.moved && Math.hypot(t.clientX - g.startX, t.clientY - g.startY) > TAP_SLOP_PX) {
      g.moved = true;
    }
    if (isMobileRef.current) {
      handlePinchMove(e.evt);
      return;
    }
    handleMouseMove(e as unknown as Konva.KonvaEventObject<MouseEvent>);
  }, [handleMouseMove, handlePinchMove]);

  const handleTouchEnd = useCallback((e: Konva.KonvaEventObject<TouchEvent>) => {
    if (isMobileRef.current) {
      if (pinchRef.current && e.evt.touches.length < 2) {
        pinchRef.current = null;
        const s = stageRef.current?.scaleX();
        if (s != null) {
          setScale(s);
          onScaleChange?.(s);
        }
      }
      return;
    }
    handleMouseUp();
  }, [handleMouseUp, onScaleChange]);

  // Mobile: the visible band (between the shell bars) at open time, so the
  // popover never sits under the top bar or tab bar. Desktop: none.
  const popoverBand = useCallback((): PopoverBand => {
    if (!isMobileRef.current) return {};
    const view = visibleRect();
    return { bandTop: view.y, bandBottom: view.y + view.h };
  }, [visibleRect]);

  // Opens the inspection popover for the current-season marker nearest the
  // world point (within MARKER_HIT_RADIUS). Returns whether one was hit.
  // Past-season overlay plantings are never in plantingsByBedIdRef.
  const inspectMarkerAt = useCallback((
    stage: Konva.Stage, w: { x: number; y: number }, p: { x: number; y: number },
  ): boolean => {
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
    if (!nearest) return false;
    const nearestBed = bedsRef.current.find(b => b.id === nearest!.bedId);
    const center = nearestBed ? markerWorldCenter(nearest, nearestBed) : null;
    const screenPos = center
      ? stage.getAbsoluteTransform().point(center)
      : { x: p.x, y: p.y };
    setPendingBedSynced(null);
    setPendingInspectSynced({
      plantingId: nearest.id, bedId: nearest.bedId, screenX: screenPos.x, screenY: screenPos.y,
      ...popoverBand(),
    });
    return true;
  }, [setPendingInspectSynced, setPendingBedSynced, popoverBand]);

  // Phase 53: a confirmed single tap/click on mobile. Marker → plant popover;
  // empty area of a current-season bed → bed popover; anything else (incl.
  // past-season overlay beds and markers) → nothing.
  const mobileInspectAt = useCallback((p: { x: number; y: number }) => {
    const stage = stageRef.current; if (!stage) return;
    const w = stage.getAbsoluteTransform().copy().invert().point(p);
    if (inspectMarkerAt(stage, w, p)) return;
    const hit = hitTestBeds(w, bedsRef.current);
    if (hit) {
      setPendingInspectSynced(null);
      setPendingBedSynced({ bedId: hit.id, screenX: p.x, screenY: p.y, ...popoverBand() });
    }
  }, [inspectMarkerAt, setPendingInspectSynced, setPendingBedSynced, popoverBand]);

  // Phase 53: mobile press (tap, or click on a narrow mouse window). A second
  // press within DOUBLE_TAP_MS and DOUBLE_TAP_SLOP_PX is a double-tap; single
  // presses wait that long so a double-tap never also opens a popover. A press
  // while a popover is open only closes it.
  const handleMobilePress = useCallback((p: { x: number; y: number }) => {
    const now = Date.now();
    const prev = lastPressRef.current;
    if (prev && now - prev.t <= DOUBLE_TAP_MS && Math.hypot(p.x - prev.x, p.y - prev.y) <= DOUBLE_TAP_SLOP_PX) {
      lastPressRef.current = null;
      cancelPendingPress();
      doubleTapZoom(p);
      return;
    }
    lastPressRef.current = { t: now, x: p.x, y: p.y };
    cancelPendingPress();
    if (pendingInspectRef.current || pendingBedRef.current) {
      setPendingInspectSynced(null);
      setPendingBedSynced(null);
      return;
    }
    pressTimerRef.current = window.setTimeout(() => {
      pressTimerRef.current = null;
      mobileInspectAt(p);
    }, DOUBLE_TAP_MS);
  }, [cancelPendingPress, doubleTapZoom, mobileInspectAt, setPendingInspectSynced, setPendingBedSynced]);

  const handleClick = useCallback((e: Konva.KonvaEventObject<MouseEvent>) => {
    if (isMobileRef.current) {
      const p = e.target.getStage()?.getPointerPosition();
      if (p) handleMobilePress({ x: p.x, y: p.y });
      return;
    }
    if (resizeDoneRef.current) { resizeDoneRef.current = false; return; }
    if (moveDoneRef.current) { moveDoneRef.current = false; return; }
    if (gridCreateDoneRef.current) { gridCreateDoneRef.current = false; return; }

    const stage = e.target.getStage(); if (!stage) return;
    const p = stage.getPointerPosition(); if (!p) return;
    const w = stage.getAbsoluteTransform().copy().invert().point(p);
    const isPanning = panActive || spaceHeld;

    // Close any open popovers if user clicks elsewhere on canvas
    if (pendingPlacementRef.current || pendingInspectRef.current) {
      setPendingPlacementSynced(null);
      setPendingInspectSynced(null);
      return;
    }

    if (isPanning) return;

    // Freeform polygon in progress: always handle polygon, skip placement/inspection
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
      // Armed but click didn't land inside the target bed — no-op.
      // Never fall through to selection or marker inspection while armed.
      return;
    }

    // Marker hit check for inspection (only when not armed). Only the current
    // plantings are considered.
    if (!armed && inspectMarkerAt(stage, w, p)) return;

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
  }, [mode, panActive, spaceHeld, onSelectBed, closeFreeform, setFreeformPtsSynced, setPendingPlacementSynced, setPendingInspectSynced, handleMobilePress, inspectMarkerAt]);

  // Mouse click. Skipped right after a tap: a browser may emulate mouse events
  // after touchend, which would run the same press a second time (opening the
  // popover on tap, then closing it on the emulated click).
  const handleStageClick = useCallback((e: Konva.KonvaEventObject<MouseEvent>) => {
    if (Date.now() - lastTapAtRef.current < TAP_CLICK_DEDUPE_MS) return;
    handleClick(e);
  }, [handleClick]);

  // Tap. A tap that ended a pan or a two-finger gesture only closes popovers
  // (and clears the post-gesture flags handleClick would have consumed); it
  // never inspects a marker or changes bed selection.
  const handleTap = useCallback((e: Konva.KonvaEventObject<Event>) => {
    lastTapAtRef.current = Date.now();
    const g = touchGestureRef.current;
    if (g && (g.multi || g.moved)) {
      resizeDoneRef.current = false;
      moveDoneRef.current = false;
      gridCreateDoneRef.current = false;
      setPendingPlacementSynced(null);
      setPendingInspectSynced(null);
      setPendingBedSynced(null);
      // A pan or pinch also breaks any double-tap in progress.
      lastPressRef.current = null;
      cancelPendingPress();
      return;
    }
    handleClick(e as unknown as Konva.KonvaEventObject<MouseEvent>);
  }, [handleClick, setPendingPlacementSynced, setPendingInspectSynced, setPendingBedSynced, cancelPendingPress]);

  const handleStageDragStart = useCallback((e: Konva.KonvaEventObject<DragEvent>) => {
    if (e.target !== e.target.getStage()) return;
    setPendingPlacementSynced(null);
    setPendingInspectSynced(null);
    setPendingBedSynced(null);
    lastPressRef.current = null;
    cancelPendingPress();
    if (stageTweenRef.current) {
      // A pan interrupts a double-tap animation: keep where it got to.
      stageTweenRef.current.destroy();
      stageTweenRef.current = null;
      const s = e.target.getStage()?.scaleX();
      if (s != null) { setScale(s); onScaleChange?.(s); }
    }
  }, [setPendingPlacementSynced, setPendingInspectSynced, setPendingBedSynced, cancelPendingPress, onScaleChange]);

  const handleDblClick = useCallback((e: Konva.KonvaEventObject<MouseEvent>) => {
    if (isMobileRef.current) return; // view-only: no bed editing
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

  // Build inspection popover (Phase 50)
  const inspectPopover = (() => {
    if (!pendingInspect || !inspectedPlanting) return null;
    const planting = inspectedPlanting;
    const name = planting.commonName ?? planting._commonName ?? 'Plant';
    const { anchored, stage } = planting.growth;
    const key = seedParam(planting);
    const ready = isHarvestReady(planting);

    const popW = 232;
    const { left, top } = anchoredPopoverPosition(
      pendingInspect.screenX, pendingInspect.screenY, popW, inspectH, size.w,
      pendingInspect.bandTop ?? 0, pendingInspect.bandBottom ?? size.h,
    );

    const markHarvested = async () => {
      if (!onMarkHarvested || harvestBusy) return;
      setHarvestBusy(true);
      setHarvestError(null);
      // Ignore the result if the popover was closed or moved on meanwhile.
      const stillOpen = () => pendingInspectRef.current?.plantingId === planting.id;
      try {
        await onMarkHarvested(planting);
        if (stillOpen()) setHarvestBusy(false);
      } catch {
        if (!stillOpen()) return;
        setHarvestBusy(false);
        setHarvestError("Couldn't mark as harvested. Try again.");
      }
    };

    return (
      <div
        ref={inspectPopoverRef}
        role="dialog"
        aria-label={name}
        tabIndex={-1}
        style={{
          outline: 'none',
          position: 'absolute', left, top, width: popW, boxSizing: 'border-box',
          background: 'var(--c-surface)', border: '1px solid var(--c-border)', borderRadius: 'var(--r-lg)',
          boxShadow: 'var(--shadow-lg)', padding: 'var(--sp-1) var(--sp-1) var(--sp-3) var(--sp-4)', zIndex: 30,
          fontFamily: 'var(--font-ui)', color: 'var(--c-text)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)' }}>
          <div style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 700, overflowWrap: 'anywhere' }}>
            {name}
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={() => setPendingInspectSynced(null)}
            style={{
              ...popoverButtonStyle, padding: 0, border: 'none', background: 'transparent',
              color: 'var(--c-text-2)', fontSize: 20, lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>

        <div style={{ paddingRight: 'var(--sp-3)' }}>
          {anchored && stage ? (
            <div style={{ fontSize: 13, color: 'var(--c-text-2)' }}>
              <div style={{ fontWeight: 600, color: 'var(--c-text)' }}>{STAGE_NAMES[stage]}</div>
              {planting.plantingDate && <div>Planted {shortDate(planting.plantingDate)}</div>}
            </div>
          ) : (
            <div style={{ fontSize: 13, color: 'var(--c-text-2)' }}>
              <p style={{ margin: 0 }}>Mark it sown in the planting guide to track its growth.</p>
              <Link
                to={key ? `/guide?open=${key}&season=${planting.season}` : '/guide'}
                style={popoverLinkStyle}
              >
                Planting guide
              </Link>
            </div>
          )}

          {planting.spacingInches != null && (
            <div style={{ fontSize: 13, color: 'var(--c-text-2)', marginTop: 'var(--sp-1)' }}>
              {planting.spacingInches} in. spacing
            </div>
          )}

          {stage === 5 && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 'var(--sp-2)', marginTop: 'var(--sp-1)' }}>
              {key && (
                <Link
                  to={`/harvest?log=new&gardenId=${planting.gardenId}&seed=${key}`}
                  style={{ ...popoverLinkStyle, alignSelf: 'flex-start' }}
                >
                  Log harvest
                </Link>
              )}
              {ready && onMarkHarvested && (
                <button
                  type="button"
                  onClick={markHarvested}
                  disabled={harvestBusy}
                  style={{
                    ...popoverButtonStyle, border: 'none',
                    background: 'var(--c-primary)', color: 'var(--c-text-on-primary)',
                    opacity: harvestBusy ? 0.6 : 1, cursor: harvestBusy ? 'default' : 'pointer',
                  }}
                >
                  {harvestBusy ? 'Saving…' : 'Mark as harvested'}
                </button>
              )}
              {harvestError && (
                <div role="alert" style={{ fontSize: 12, color: 'var(--c-danger)' }}>{harvestError}</div>
              )}
            </div>
          )}

          {!isMobile && (
            <button
              type="button"
              onClick={() => {
                onConfirmRemoval(planting);
                setPendingInspectSynced(null);
              }}
              style={{
                ...popoverButtonStyle, width: '100%', marginTop: 'var(--sp-3)',
                border: '1px solid var(--c-border)', background: 'transparent', color: 'var(--c-danger)',
              }}
            >
              Remove plant
            </button>
          )}
        </div>
      </div>
    );
  })();

  // Phase 53: mobile bed popover. Same placement/edge-flip as the plant popover.
  const bedPopover = (() => {
    if (!pendingBed || !inspectedBed) return null;
    const label = inspectedBed.label || 'Bed';
    const count = (plantingsByBedId[inspectedBed.id] ?? []).length;
    const countText = count === 0 ? 'Empty' : count === 1 ? '1 plant' : `${count} plants`;
    const popW = 220;
    const { left, top } = anchoredPopoverPosition(
      pendingBed.screenX, pendingBed.screenY, popW, bedPopH, size.w,
      pendingBed.bandTop ?? 0, pendingBed.bandBottom ?? size.h,
    );
    return (
      <div
        ref={bedPopoverRef}
        role="dialog"
        aria-label={label}
        tabIndex={-1}
        style={{
          outline: 'none',
          position: 'absolute', left, top, width: popW, boxSizing: 'border-box',
          background: 'var(--c-surface)', border: '1px solid var(--c-border)', borderRadius: 'var(--r-lg)',
          boxShadow: 'var(--shadow-lg)', padding: 'var(--sp-1) var(--sp-1) var(--sp-3) var(--sp-4)', zIndex: 30,
          fontFamily: 'var(--font-ui)', color: 'var(--c-text)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)' }}>
          <div style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 700, overflowWrap: 'anywhere' }}>
            {label}
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={() => setPendingBedSynced(null)}
            style={{
              ...popoverButtonStyle, padding: 0, border: 'none', background: 'transparent',
              color: 'var(--c-text-2)', fontSize: 20, lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)', paddingRight: 'var(--sp-3)' }}>
          <span style={{
            display: 'inline-flex', alignItems: 'center',
            padding: '0 var(--sp-2)', lineHeight: 1.7, borderRadius: 'var(--r-full)',
            background: 'var(--c-surface-raised)', border: '1px solid var(--c-border)',
            fontSize: 12, fontWeight: 600, color: 'var(--c-text-2)',
          }}>
            {inspectedBed.type === 'grid' ? 'Grid' : 'Freeform'}
          </span>
          <span style={{ fontSize: 13, color: 'var(--c-text-2)' }}>{countText}</span>
        </div>
      </div>
    );
  })();

  return (
    <div style={{ position: 'relative', width: size.w, height: size.h, touchAction: 'none' }}>
      {/* Spans the area between the shell bars; measured by fitToBeds. */}
      <div
        ref={insetProbeRef}
        aria-hidden="true"
        style={{
          position: 'fixed', left: 0, width: 0,
          top: 'var(--shell-top, 0px)', bottom: 'var(--shell-bottom, 0px)',
          visibility: 'hidden', pointerEvents: 'none',
        }}
      />
      <Stage
        ref={stageRef}
        width={size.w}
        height={size.h}
        // Mobile: one-finger drag always pans (view-only canvas). The drag
        // distance keeps a slightly wobbly tap from counting as a pan.
        draggable={isMobile || panActive || spaceHeld}
        dragDistance={isMobile ? TAP_SLOP_PX : undefined}
        onDragStart={handleStageDragStart}
        onWheel={handleWheel}
        onMouseDown={isMobile ? undefined : handleMouseDown}
        onMouseMove={isMobile ? undefined : handleMouseMove}
        onMouseUp={isMobile ? undefined : handleMouseUp}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onClick={handleStageClick}
        onTap={handleTap}
        onDblClick={isMobile ? undefined : handleDblClick}
      >
        {/* Layer 1: grid lines */}
        <Layer listening={false}>
          {scale >= GRID_HIDE_THRESHOLD && gridLines}
        </Layer>

        {/* Layer 2: beds */}
        <Layer name="thumb-beds" listening={true}>
          {beds.map(bed => {
            const selected = bed.id === selectedBedId;
            const isMoving = dragOffset != null && moveRef.current?.bedId === bed.id;
            const isMoveOverlapping = isMoving && moveOverlap;
            // "Placing" state: this bed is the armed target
            const isPlacing = selected && armedSeed != null && !isMoving;
            const isConflicted = conflictedBedIds?.has(bed.id) ?? false;

            if (bed.type === 'grid' && bed.grid) {
              const { x, y, cols, rows } = bed.grid;
              const renderX = isMoving ? x * GRID_PX + dragOffset!.x : x * GRID_PX;
              const renderY = isMoving ? y * GRID_PX + dragOffset!.y : y * GRID_PX;
              const bw = cols * GRID_PX;
              const bh = rows * GRID_PX;

              const cellLines = gridCellLines(cols, rows, '#b8d0ba');

              const gridFill = isMoveOverlapping ? 'rgba(200,80,80,0.4)'
                : isPlacing ? 'rgba(45,106,79,0.18)'
                : '#d4edda';
              const gridStroke = isMoveOverlapping ? '#c05050'
                : isPlacing ? '#2d6a4f'
                : selected ? '#1a5c3a'
                : '#2d6a4f';
              const gridStrokeW = isPlacing ? 2 : selected ? 3 : 1.5;

              return (
                <Group key={bed.id} id={bed.id} x={renderX} y={renderY}>
                  <Rect width={bw} height={bh}
                    fill={gridFill}
                    stroke={gridStroke}
                    strokeWidth={gridStrokeW} cornerRadius={2} />
                  {isConflicted && (
                    <Rect
                      width={bw} height={bh}
                      fill="rgba(200, 138, 42, 0.22)"
                      stroke="#C88A2A"
                      strokeWidth={1}
                      cornerRadius={2}
                      listening={false}
                    />
                  )}
                  {cellLines}
                </Group>
              );
            }

            if (bed.type === 'freeform' && bed.freeform) {
              const { closed } = bed.freeform;
              const pts = isMoving
                ? bed.freeform.points.map((v, i) => i % 2 === 0 ? v + dragOffset!.x : v + dragOffset!.y)
                : bed.freeform.points;
              const ffFill = isMoveOverlapping ? 'rgba(200,80,80,0.4)'
                : isPlacing ? 'rgba(45,106,79,0.15)'
                : 'rgba(255,243,205,0.7)';
              const ffStroke = isMoveOverlapping ? '#c05050'
                : isPlacing ? '#2d6a4f'
                : selected ? '#8a5a00'
                : '#b8860b';
              const ffStrokeW = isPlacing ? 2 : selected ? 3 : 1.5;

              return (
                <Group key={bed.id} id={bed.id}>
                  <Line points={pts} closed={closed}
                    fill={ffFill}
                    stroke={ffStroke}
                    strokeWidth={ffStrokeW} dash={[6, 4]} />
                  {isConflicted && (
                    <Line
                      points={pts}
                      closed
                      fill="rgba(200, 138, 42, 0.22)"
                      stroke="#C88A2A"
                      strokeWidth={1}
                      listening={false}
                    />
                  )}
                </Group>
              );
            }

            return null;
          })}
        </Layer>

        {/* Layer 2b: past-season overlay. Read-only: listening off, kept out of
            bedsRef / plantingsByBedIdRef so JS hit-testing never sees it, plain
            markers (no refs) so no animation or displayed-stage PATCH, and not a
            thumb-* layer so it never reaches the garden thumbnail. */}
        {overlayBeds.length > 0 && (
          <Layer name="season-overlay" listening={false}>
            {overlayBeds.map(bed => <OverlayBed key={bed.id} bed={bed} />)}
            {overlayBeds.map(bed => (overlayPlantingsByBedId[bed.id] ?? []).map(planting => {
              const center = markerWorldCenter(planting, bed);
              if (!center) return null;
              return (
                <PlantingMarker
                  key={planting.id}
                  planting={planting}
                  x={center.x}
                  y={center.y}
                  // Plain markers ignore scale; a constant keeps the memo on zoom.
                  scale={1}
                  plain={OVERLAY_MARKER_PLAIN}
                />
              );
            }))}
          </Layer>
        )}

        {/* Layer 3: planting markers (visual only — clicks resolved in JS) */}
        <Layer name="thumb-markers" listening={false}>
          {beds.map(bed => {
            const plantings = plantingsByBedId[bed.id] ?? [];
            const isMoving = dragOffset != null && moveRef.current?.bedId === bed.id;
            const offsetX = isMoving ? dragOffset!.x : 0;
            const offsetY = isMoving ? dragOffset!.y : 0;

            return plantings.map(planting => {
              const center = markerWorldCenter(planting, bed);
              if (!center) return null;
              const id = planting.id;
              return (
                <PlantingMarker
                  key={id}
                  planting={planting}
                  x={center.x + offsetX}
                  y={center.y + offsetY}
                  scale={scale}
                  conflicted={conflictedIds?.has(id) ?? false}
                  registerRef={registerMarkerRef}
                />
              );
            });
          })}
        </Layer>

        {/* Layer 5: chrome overlay — bed labels + overcrowding badges (above markers) */}
        <Layer name="thumb-labels" listening={false}>
          {/* Bed name labels + overcrowding badges, centered above the top border */}
          {beds.map(bed => {
            const isMoving = dragOffset != null && moveRef.current?.bedId === bed.id;
            const labelText = bed.label || 'Bed';
            const occ = occupancyByBedId?.[bed.id];

            // Label chip
            const lblPad = 3;
            const lblChipW = Math.max(labelText.length * 7 + lblPad * 2, 28);
            const lblChipH = 20;

            // Badge chip (only when over-capacity)
            const isSFGGrid = garden?.growingMethod === 'square_foot' && bed.type === 'grid';
            const unit = isSFGGrid ? 'cells' : 'sq ft';
            const badgeText = occ?.over
              ? `${Math.ceil(occ.consumed)}/${Math.floor(occ.capacity)} ${unit}`
              : null;
            const bdgPad = 4;
            const bdgChipW = badgeText ? Math.max(badgeText.length * 5.2 + bdgPad * 2, 38) : 0;
            const bdgChipH = 14;

            // Chips sit just above the top border; bottom of chip row = topEdge - aboveGap
            const aboveGap = 4;

            // Compute label/badge x positions centered on anchorX, badge right of label.
            // isNarrow: stack badge below label (both centered), rather than side-by-side.
            const layoutChips = (anchorX: number, topEdge: number, refWidth: number) => {
              const isNarrow = badgeText != null && (lblChipW + 4 + bdgChipW > refWidth);

              let lblChipX: number, lblChipY: number;
              let bdgChipX: number, bdgChipY: number;

              if (!badgeText) {
                lblChipX = anchorX - lblChipW / 2;
                lblChipY = topEdge - lblChipH - aboveGap;
                bdgChipX = 0; bdgChipY = 0;
              } else if (isNarrow) {
                // Stack: label on top row, badge on row below, both centered
                lblChipX = anchorX - lblChipW / 2;
                lblChipY = topEdge - lblChipH - bdgChipH - 2 - aboveGap;
                bdgChipX = anchorX - bdgChipW / 2;
                bdgChipY = topEdge - bdgChipH - aboveGap;
              } else {
                // Side-by-side: whole group centered on anchorX, badge right of label
                const groupW = lblChipW + 4 + bdgChipW;
                lblChipX = anchorX - groupW / 2;
                lblChipY = topEdge - lblChipH - aboveGap;
                bdgChipX = lblChipX + lblChipW + 4;
                bdgChipY = topEdge - bdgChipH - aboveGap;
              }

              return { lblChipX, lblChipY, bdgChipX, bdgChipY, isNarrow };
            };

            if (bed.type === 'grid' && bed.grid) {
              const { x, y, cols } = bed.grid;
              const renderX = isMoving ? x * GRID_PX + dragOffset!.x : x * GRID_PX;
              const renderY = isMoving ? y * GRID_PX + dragOffset!.y : y * GRID_PX;
              const bw = cols * GRID_PX;
              const anchorX = renderX + bw / 2;
              const { lblChipX, lblChipY, bdgChipX, bdgChipY } = layoutChips(anchorX, renderY, bw);

              return (
                <Group key={`lbl-${bed.id}`}>
                  <Rect x={lblChipX} y={lblChipY} width={lblChipW} height={lblChipH}
                    fill="rgba(250,247,242,0.92)" stroke="#d8ceba" strokeWidth={1}
                    cornerRadius={3} />
                  <Text text={labelText} x={lblChipX + lblPad} y={lblChipY + 4}
                    fontSize={12} fill="#264a2e" fontFamily="Georgia, serif" />
                  {badgeText && (
                    <>
                      <Rect x={bdgChipX} y={bdgChipY} width={bdgChipW} height={bdgChipH}
                        fill="rgba(200,138,42,0.18)" stroke="#C88A2A" strokeWidth={0.5}
                        cornerRadius={4} />
                      <Text text={badgeText} x={bdgChipX + bdgPad} y={bdgChipY + 3}
                        fontSize={9} fill="#7a5c10" fontFamily="system-ui, sans-serif" />
                    </>
                  )}
                </Group>
              );
            }

            if (bed.type === 'freeform' && bed.freeform) {
              const pts = isMoving
                ? bed.freeform.points.map((v, i) => i % 2 === 0 ? v + dragOffset!.x : v + dragOffset!.y)
                : bed.freeform.points;
              // Topmost vertex (min Y); use its x as the horizontal anchor
              let topVertX = pts[0], topVertY = pts[1];
              let minX = pts[0], maxX = pts[0];
              for (let i = 2; i < pts.length; i += 2) {
                if (pts[i + 1] < topVertY) { topVertY = pts[i + 1]; topVertX = pts[i]; }
                if (pts[i] < minX) minX = pts[i];
                if (pts[i] > maxX) maxX = pts[i];
              }
              const bboxW = maxX - minX;
              const { lblChipX, lblChipY, bdgChipX, bdgChipY } = layoutChips(topVertX, topVertY, bboxW);

              return (
                <Group key={`lbl-${bed.id}`}>
                  <Rect x={lblChipX} y={lblChipY} width={lblChipW} height={lblChipH}
                    fill="rgba(250,247,242,0.92)" stroke="#d8ceba" strokeWidth={1}
                    cornerRadius={3} />
                  <Text text={labelText} x={lblChipX + lblPad} y={lblChipY + 4}
                    fontSize={12} fill="#5a3e00" fontFamily="Georgia, serif" />
                  {badgeText && (
                    <>
                      <Rect x={bdgChipX} y={bdgChipY} width={bdgChipW} height={bdgChipH}
                        fill="rgba(200,138,42,0.18)" stroke="#C88A2A" strokeWidth={0.5}
                        cornerRadius={4} />
                      <Text text={badgeText} x={bdgChipX + bdgPad} y={bdgChipY + 3}
                        fontSize={9} fill="#7a5c10" fontFamily="system-ui, sans-serif" />
                    </>
                  )}
                </Group>
              );
            }

            return null;
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
      {inspectPopover}
      {bedPopover}
    </div>
  );
});

GardenCanvas.displayName = 'GardenCanvas';
export default GardenCanvas;
