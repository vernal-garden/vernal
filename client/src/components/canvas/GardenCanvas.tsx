import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import Konva from 'konva';
import type { Box as KonvaBox } from 'konva/lib/shapes/Transformer';
import { Layer, Line, Group, Rect, Stage, Text, Transformer } from 'react-konva';
import type { Bed, CreateBedPayload, UpdateBedPayload } from '../../hooks/useGarden';

Konva.hitOnDragEnabled = true;

export const GRID_PX = 30;
const ZOOM_STEP = 1.1;
const MIN_SCALE = 0.2;
const MAX_SCALE = 5;
const GRID_HIDE_THRESHOLD = 0.4;

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
  mode: 'grid' | 'freeform';
  panActive: boolean;
  gardenId: string;
}

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

function gridBedsOverlap(
  a: { x: number; y: number; cols: number; rows: number },
  b: { x: number; y: number; cols: number; rows: number }
) {
  return a.x < b.x + b.cols && a.x + a.cols > b.x &&
         a.y < b.y + b.rows && a.y + a.rows > b.y;
}

// ---- Component ----

const GardenCanvas = forwardRef<GardenCanvasRef, Props>(({
  beds, selectedBedId, onSelectBed, onDoubleBed,
  onCreateBed, onUpdateBedGeometry,
  onScaleChange, mode, panActive, gardenId: _gardenId,
}, ref) => {
  const stageRef = useRef<Konva.Stage>(null);
  const transformerRef = useRef<Konva.Transformer>(null);
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

  // Move
  const moveRef = useRef<{ bedId: string; startWorld: { x: number; y: number }; moved: boolean } | null>(null);
  const [dragOffset, setDragOffset] = useState<{ x: number; y: number } | null>(null);
  const dragOffsetRef = useRef<{ x: number; y: number } | null>(null);
  const setDragOffsetSynced = useCallback((v: { x: number; y: number } | null) => {
    dragOffsetRef.current = v;
    setDragOffset(v);
  }, []);
  const selectedBedIdRef = useRef<string | null>(selectedBedId);
  useEffect(() => { selectedBedIdRef.current = selectedBedId; }, [selectedBedId]);
  const bedsRef = useRef<Bed[]>(beds);
  useEffect(() => { bedsRef.current = beds; }, [beds]);

  const setFreeformPtsSynced = useCallback((pts: number[]) => {
    freeformPtsRef.current = pts;
    setFreeformPts(pts);
  }, []);

  const closeFreeform = useCallback((pts: number[]) => {
    if (pts.length < 6) { setFreeformPtsSynced([]); setCursorWorld(null); return; }
    onCreateBed({
      type: 'freeform',
      label: `Bed ${bedsRef.current.length + 1}`,
      freeform: { points: pts, closed: true },
    });
    setFreeformPtsSynced([]);
    setCursorWorld(null);
  }, [onCreateBed, setFreeformPtsSynced]);

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
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceHeld(false);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => { window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp); };
  }, [setFreeformPtsSynced, setDragOffsetSynced]);

  // Cursor style
  useEffect(() => {
    const el = stageRef.current?.container();
    if (!el) return;
    if (panActive || spaceHeld) { el.style.cursor = 'grab'; }
    else if (mode === 'freeform') { el.style.cursor = 'crosshair'; }
    else { el.style.cursor = 'default'; }
  }, [panActive, spaceHeld, mode]);

  // Transformer: attach to selected bed's node
  useEffect(() => {
    const stage = stageRef.current;
    const tr = transformerRef.current;
    if (!stage || !tr) return;
    if (!selectedBedId) {
      tr.nodes([]);
      tr.getLayer()?.batchDraw();
      return;
    }
    const node = stage.findOne('#' + selectedBedId);
    if (node) {
      tr.nodes([node as Konva.Node]);
    } else {
      tr.nodes([]);
    }
    tr.getLayer()?.batchDraw();
  }, [selectedBedId, beds]);

  // Transformer resize end
  const handleTransformEnd = useCallback(() => {
    const tr = transformerRef.current;
    if (!tr || !selectedBedId) return;
    const node = tr.nodes()[0] as Konva.Group | undefined;
    if (!node) return;
    const bed = bedsRef.current.find(b => b.id === selectedBedId);
    if (!bed) return;

    if (bed.type === 'grid' && bed.grid) {
      const newX = Math.round(node.x() / GRID_PX);
      const newY = Math.round(node.y() / GRID_PX);
      const newCols = Math.max(1, Math.round((bed.grid.cols * GRID_PX * node.scaleX()) / GRID_PX));
      const newRows = Math.max(1, Math.round((bed.grid.rows * GRID_PX * node.scaleY()) / GRID_PX));
      node.scaleX(1); node.scaleY(1);
      node.x(newX * GRID_PX); node.y(newY * GRID_PX);
      const newGrid = { x: newX, y: newY, cols: newCols, rows: newRows };
      const overlap = bedsRef.current.some(b => b.id !== selectedBedId && b.type === 'grid' && b.grid && gridBedsOverlap(newGrid, b.grid));
      if (!overlap) {
        onUpdateBedGeometry(selectedBedId, { grid: newGrid });
      } else {
        node.x(bed.grid.x * GRID_PX); node.y(bed.grid.y * GRID_PX);
        node.getLayer()?.batchDraw();
      }
    } else if (bed.type === 'freeform' && bed.freeform) {
      const sx = node.scaleX();
      const sy = node.scaleY();
      const tx = node.x();
      const ty = node.y();
      const newPoints = bed.freeform.points.map((v, i) =>
        i % 2 === 0 ? tx + v * sx : ty + v * sy
      );
      node.scaleX(1); node.scaleY(1); node.x(0); node.y(0);
      onUpdateBedGeometry(selectedBedId, { freeform: { points: newPoints, closed: bed.freeform.closed } });
    }
    tr.getLayer()?.batchDraw();
  }, [selectedBedId, onUpdateBedGeometry]);

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

    if (mode === 'grid') {
      const hitBed = hitTestBeds(w, beds);
      if (hitBed) {
        moveRef.current = { bedId: hitBed.id, startWorld: w, moved: false };
        return;
      }
      const cell = worldToCell(w.x, w.y);
      gridDragRef.current = { startCell: cell, startWorld: w, curCell: cell, moved: false };
    } else {
      const hitBed = hitTestBeds(w, beds);
      if (hitBed) moveRef.current = { bedId: hitBed.id, startWorld: w, moved: false };
    }
  }, [mode, panActive, spaceHeld, beds]);

  const handleMouseMove = useCallback((_e: Konva.KonvaEventObject<MouseEvent>) => {
    const stage = stageRef.current; if (!stage) return;
    const p = stage.getPointerPosition(); if (!p) return;
    const w = stage.getAbsoluteTransform().copy().invert().point(p);

    if (mode === 'freeform') setCursorWorld(w);

    if (gridDragRef.current) {
      const { startCell, startWorld, moved } = gridDragRef.current;
      if (!moved && Math.hypot(w.x - startWorld.x, w.y - startWorld.y) > 4) {
        gridDragRef.current.moved = true;
      }
      if (gridDragRef.current.moved) {
        const cell = worldToCell(w.x, w.y);
        gridDragRef.current.curCell = cell;
        const g = gridFromCells(startCell, cell);
        const overlap = beds.some(b => b.type === 'grid' && b.grid && gridBedsOverlap(g, b.grid));
        setGridPreview({ ...g, overlap });
      }
      return;
    }

    if (moveRef.current) {
      const dx = w.x - moveRef.current.startWorld.x;
      const dy = w.y - moveRef.current.startWorld.y;
      if (!moveRef.current.moved && Math.hypot(dx, dy) > 4) moveRef.current.moved = true;
      if (moveRef.current.moved) setDragOffsetSynced({ x: dx, y: dy });
    }
  }, [mode, beds]);

  const handleMouseUp = useCallback(() => {
    if (gridDragRef.current) {
      const wasMoved = gridDragRef.current.moved;
      gridDragRef.current = null;
      if (wasMoved && gridPreview) {
        const preview = gridPreview;
        setGridPreview(null);
        if (!preview.overlap) {
          onCreateBed({ type: 'grid', label: `Bed ${bedsRef.current.length + 1}`, grid: { x: preview.x, y: preview.y, cols: preview.cols, rows: preview.rows } });
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
          const overlap = bedsRef.current.some(b => b.id !== bedId && b.type === 'grid' && b.grid && gridBedsOverlap(newGrid, b.grid));
          if (!overlap) onUpdateBedGeometry(bedId, { grid: newGrid });
        } else if (bed.type === 'freeform' && bed.freeform) {
          const newPoints = bed.freeform.points.map((v, i) => i % 2 === 0 ? v + dragOffsetRef.current!.x : v + dragOffsetRef.current!.y);
          onUpdateBedGeometry(bedId, { freeform: { points: newPoints, closed: bed.freeform.closed } });
        }
      }
    }
    moveRef.current = null;
    setDragOffsetSynced(null);
  }, [gridPreview, onCreateBed, onUpdateBedGeometry, setDragOffsetSynced]);

  const handleClick = useCallback((e: Konva.KonvaEventObject<MouseEvent>) => {
    if (moveRef.current?.moved) { moveRef.current = null; return; }
    if (gridDragRef.current) return;

    const stage = e.target.getStage(); if (!stage) return;
    const p = stage.getPointerPosition(); if (!p) return;
    const w = stage.getAbsoluteTransform().copy().invert().point(p);
    const isPanning = panActive || spaceHeld;

    if (mode === 'freeform' && !isPanning) {
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

  const boundBoxFunc = useCallback((_oldBox: KonvaBox, newBox: KonvaBox): KonvaBox => {
    if (selectedBed?.type === 'grid') {
      return {
        ...newBox,
        width: Math.max(GRID_PX, Math.round(newBox.width / GRID_PX) * GRID_PX),
        height: Math.max(GRID_PX, Math.round(newBox.height / GRID_PX) * GRID_PX),
      };
    }
    return newBox;
  }, [selectedBed]);

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

      {/* Layer 2: beds (listening=true for Transformer) */}
      <Layer listening={true}>
        {beds.map(bed => {
          const selected = bed.id === selectedBedId;
          const isMoving = dragOffset != null && moveRef.current?.bedId === bed.id;

          if (bed.type === 'grid' && bed.grid) {
            const { x, y, cols, rows } = bed.grid;
            const renderX = isMoving ? x * GRID_PX + dragOffset!.x : x * GRID_PX;
            const renderY = isMoving ? y * GRID_PX + dragOffset!.y : y * GRID_PX;
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
                <Rect width={w} height={h} fill="#d4edda"
                  stroke={selected ? '#1a5c3a' : '#2d6a4f'}
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
            const { minX, minY } = freeformBbox(pts);

            return (
              <Group key={bed.id} id={bed.id}>
                <Line points={pts} closed={closed}
                  fill="rgba(255,243,205,0.7)"
                  stroke={selected ? '#8a5a00' : '#b8860b'}
                  strokeWidth={selected ? 3 : 1.5} dash={[6, 4]} />
                <Text text={bed.label || 'Bed'} fontSize={12} x={minX + 4} y={minY + 4} fill="#5a3e00" fontFamily="Georgia, serif" />
              </Group>
            );
          }

          return null;
        })}
      </Layer>

      {/* Layer 3: creation previews + Transformer */}
      <Layer listening={true}>
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
            listening={false}
          />
        )}

        {/* Freeform creation preview */}
        {mode === 'freeform' && freeformPts.length >= 2 && (
          <>
            <Line points={freeformPts} stroke="#b8860b" strokeWidth={1.5} dash={[4, 3]} closed={false} listening={false} />
            {cursorWorld && (
              <Line
                points={[freeformPts[freeformPts.length - 2], freeformPts[freeformPts.length - 1], cursorWorld.x, cursorWorld.y]}
                stroke="#b8860b" strokeWidth={1} dash={[4, 4]} opacity={0.5} listening={false}
              />
            )}
            {cursorWorld && freeformPts.length >= 4 && (() => {
              const dist = Math.hypot(cursorWorld.x - freeformPts[0], cursorWorld.y - freeformPts[1]) * scale;
              return dist <= 12 ? (
                <Rect x={freeformPts[0] - 5} y={freeformPts[1] - 5} width={10} height={10}
                  fill="rgba(184,134,11,0.3)" stroke="#b8860b" strokeWidth={1.5} listening={false} />
              ) : null;
            })()}
            {Array.from({ length: freeformPts.length / 2 }, (_, i) => (
              <Rect key={i} x={freeformPts[i * 2] - 3} y={freeformPts[i * 2 + 1] - 3}
                width={6} height={6} fill="#b8860b" listening={false} />
            ))}
          </>
        )}

        {/* Transformer for selected bed */}
        <Transformer
          ref={transformerRef}
          rotateEnabled={false}
          boundBoxFunc={boundBoxFunc}
          onTransformEnd={handleTransformEnd}
          anchorStroke="#2d6a4f"
          anchorFill="#fff"
          anchorSize={8}
          borderStroke="#2d6a4f"
          borderDash={[4, 3]}
        />
      </Layer>
    </Stage>
  );
});

GardenCanvas.displayName = 'GardenCanvas';
export default GardenCanvas;
