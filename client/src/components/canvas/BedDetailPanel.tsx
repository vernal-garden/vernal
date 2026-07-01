import { useEffect, useRef, useState } from 'react';
import type { Bed } from '../../hooks/useGarden';
import { GRID_PX } from './GardenCanvas';

function shoelaceArea(points: number[]): number {
  let area = 0;
  const n = points.length / 2;
  for (let i = 0; i < n; i++) {
    const x1 = points[i * 2], y1 = points[i * 2 + 1];
    const x2 = points[((i + 1) % n) * 2], y2 = points[((i + 1) % n) * 2 + 1];
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area) / 2;
}

interface Props {
  bed: Bed;
  plantingCount: number;
  onClose: () => void;
  onRename: (label: string) => void;
  onDelete: () => void;
  focusName: boolean;
  onAddPlant: () => void;
}

export default function BedDetailPanel({ bed, plantingCount, onClose, onRename, onDelete, focusName, onAddPlant }: Props) {
  const [nameVal, setNameVal] = useState(bed.label);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  // Sync nameVal when bed changes (optimistic update resolves, or different bed selected)
  useEffect(() => { setNameVal(bed.label); }, [bed.label]);

  // Focus + select name when focusName changes (double-click opens panel focused)
  useEffect(() => {
    if (focusName && nameRef.current) {
      nameRef.current.focus();
      nameRef.current.select();
    }
  }, [focusName, bed.id]);

  // Reset confirm state when bed changes
  useEffect(() => { setConfirmDelete(false); }, [bed.id]);

  const isGrid = bed.type === 'grid' && bed.grid != null;
  const isFreeform = bed.type === 'freeform' && bed.freeform != null;

  let dimensionLine: string;
  if (isGrid && bed.grid) {
    const { cols, rows } = bed.grid;
    dimensionLine = `${cols} × ${rows} ft · ${cols * rows} sq ft`;
  } else if (isFreeform && bed.freeform) {
    const sqFt = Math.round(shoelaceArea(bed.freeform.points) / (GRID_PX * GRID_PX));
    dimensionLine = `~${sqFt} sq ft (approximate)`;
  } else {
    dimensionLine = '—';
  }

  const commitName = () => {
    const trimmed = nameVal.trim();
    if (!trimmed) { setNameVal(bed.label); return; }
    if (trimmed !== bed.label) onRename(trimmed);
  };

  const handleDelete = () => {
    if (plantingCount > 0) { setConfirmDelete(true); return; }
    onDelete();
  };

  return (
    <div style={{
      position: 'fixed', right: 0, top: 0, bottom: 0, width: 280,
      display: 'flex', flexDirection: 'column',
      background: '#faf7f2', borderLeft: '1px solid #d8ceba',
      boxShadow: '-4px 0 32px rgba(20,40,20,0.12)',
      fontFamily: 'system-ui, -apple-system, sans-serif', zIndex: 20,
    }}>
      {/* Header */}
      <div style={{ background: '#1c3a28', padding: '20px 20px 16px', position: 'relative', flexShrink: 0 }}>
        <div style={{
          display: 'inline-flex', alignItems: 'center', padding: '2px 10px',
          borderRadius: 999, fontSize: 10, fontWeight: 500, letterSpacing: '0.07em',
          textTransform: 'uppercase', marginBottom: 10,
          background: isGrid ? 'rgba(212,237,218,0.15)' : 'rgba(255,243,205,0.12)',
          border: isGrid ? '1px solid rgba(168,212,176,0.35)' : '1px solid rgba(240,192,96,0.3)',
          color: isGrid ? '#9dcfaa' : '#e8b84a',
        }}>
          {isGrid ? 'Grid' : 'Freeform'}
        </div>

        {/* Editable name */}
        <input
          ref={nameRef}
          value={nameVal}
          maxLength={30}
          onChange={e => setNameVal(e.target.value)}
          onBlur={commitName}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.currentTarget.blur(); }
            if (e.key === 'Escape') { setNameVal(bed.label); e.currentTarget.blur(); }
          }}
          style={{
            display: 'block', width: '100%', boxSizing: 'border-box',
            fontFamily: "'Fraunces', Georgia, serif", fontSize: 18, fontWeight: 600,
            color: '#e8f4e8', lineHeight: 1.25, paddingRight: 32,
            background: 'transparent', border: 'none', outline: 'none',
            borderBottom: '1px solid rgba(255,255,255,0.15)',
            paddingBottom: 2,
          }}
        />

        <button onClick={onClose} aria-label="Close panel" style={{
          position: 'absolute', top: 16, right: 16, width: 28, height: 28,
          borderRadius: '50%', background: 'rgba(255,255,255,0.08)',
          border: '1px solid rgba(255,255,255,0.18)', color: 'rgba(232,244,232,0.7)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: 0,
        }}>×</button>
      </div>

      {/* Body */}
      <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: 16, overflowY: 'auto', flex: 1 }}>
        <div>
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#9a8e7e', marginBottom: 6 }}>
            Dimensions
          </div>
          <div style={{ fontFamily: "'DM Mono', 'Courier New', monospace", fontSize: 14, color: '#2c3e2c', background: '#f0ebe0', border: '1px solid #e0d8c8', borderRadius: 6, padding: '8px 12px' }}>
            {dimensionLine}
          </div>
        </div>

        <div>
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#9a8e7e', marginBottom: 6 }}>
            Season
          </div>
          <div style={{ fontFamily: "'DM Mono', 'Courier New', monospace", fontSize: 14, color: '#2c3e2c', background: '#f0ebe0', border: '1px solid #e0d8c8', borderRadius: 6, padding: '8px 12px' }}>
            {bed.season}
          </div>
        </div>

        {/* Add plant */}
        <button onClick={onAddPlant} style={{
          padding: '10px', borderRadius: 6,
          border: '1px solid #2d6a4f', background: '#2d6a4f',
          color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 500,
        }}>
          + Add plant
        </button>

        {/* Delete */}
        {!confirmDelete ? (
          <button onClick={handleDelete} style={{
            marginTop: 'auto', padding: '10px', borderRadius: 6,
            border: '1px solid #e8b8b8', background: 'transparent',
            color: '#a04040', cursor: 'pointer', fontSize: 13,
          }}>
            Delete bed
          </button>
        ) : (
          <div style={{ marginTop: 'auto', background: '#fff8f8', border: '1px solid #e8c8c8', borderRadius: 8, padding: 14 }}>
            <div style={{ fontSize: 13, color: '#5a3030', marginBottom: 10 }}>
              This bed has {plantingCount} plant{plantingCount !== 1 ? 's' : ''} — deleting removes them too.
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => setConfirmDelete(false)} style={{ flex: 1, padding: '8px', borderRadius: 6, border: '1px solid #d8ceba', background: 'transparent', cursor: 'pointer', fontSize: 12 }}>
                Cancel
              </button>
              <button onClick={onDelete} style={{ flex: 1, padding: '8px', borderRadius: 6, border: 'none', background: '#c04040', color: '#fff', cursor: 'pointer', fontSize: 12 }}>
                Delete
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
