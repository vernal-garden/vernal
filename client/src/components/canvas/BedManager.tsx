import { useState } from 'react';
import type { Bed } from '../../hooks/useGarden';
import type { PlantingsByBedId } from '../../hooks/usePlantings';

interface Props {
  beds: Bed[];
  plantingsByBedId: PlantingsByBedId;
  onClose: () => void;
  onRename: (bedId: string, label: string) => void;
  onDelete: (bedId: string) => void;
  onFocusBed: (bed: Bed) => void;
}

export default function BedManager({ beds, plantingsByBedId, onClose, onRename, onDelete, onFocusBed }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editVal, setEditVal] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const startEdit = (bed: Bed) => {
    setEditingId(bed.id);
    setEditVal(bed.label);
  };

  const commitEdit = (bed: Bed) => {
    const trimmed = editVal.trim();
    if (trimmed && trimmed !== bed.label) onRename(bed.id, trimmed);
    setEditingId(null);
  };

  const handleDelete = (bed: Bed) => {
    const count = plantingsByBedId[bed.id]?.length ?? 0;
    if (count > 0) { setConfirmDeleteId(bed.id); return; }
    onDelete(bed.id);
  };

  return (
    <div style={{
      position: 'fixed', left: 0, top: 0, bottom: 0, width: 300,
      display: 'flex', flexDirection: 'column',
      background: '#faf7f2', borderRight: '1px solid #d8ceba',
      boxShadow: '4px 0 32px rgba(20,40,20,0.12)',
      fontFamily: 'system-ui, -apple-system, sans-serif', zIndex: 20,
    }}>
      {/* Header */}
      <div style={{
        background: '#1c3a28', padding: '18px 20px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        flexShrink: 0,
      }}>
        <span style={{ fontFamily: "'Fraunces', Georgia, serif", fontSize: 17, fontWeight: 600, color: '#e8f4e8' }}>
          Beds ({beds.length})
        </span>
        <button onClick={onClose} aria-label="Close bed manager" style={{
          width: 28, height: 28, borderRadius: '50%', background: 'rgba(255,255,255,0.08)',
          border: '1px solid rgba(255,255,255,0.18)', color: 'rgba(232,244,232,0.7)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          cursor: 'pointer', fontSize: 14, padding: 0,
        }}>×</button>
      </div>

      {/* List */}
      <div style={{ overflowY: 'auto', flex: 1, padding: '8px 0' }}>
        {beds.length === 0 && (
          <div style={{ padding: '32px 20px', textAlign: 'center', color: '#9a8e7e', fontSize: 13 }}>
            No beds yet. Draw on the canvas to create one.
          </div>
        )}
        {beds.map(bed => {
          const count = plantingsByBedId[bed.id]?.length ?? 0;
          return (
            <div key={bed.id} style={{
              padding: '10px 16px', borderBottom: '1px solid #ede8dd',
              display: 'flex', flexDirection: 'column', gap: 6,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {/* Type chip */}
                <span style={{
                  fontSize: 9, fontWeight: 600, letterSpacing: '0.07em', textTransform: 'uppercase',
                  padding: '2px 7px', borderRadius: 999,
                  background: bed.type === 'grid' ? 'rgba(45,106,79,0.1)' : 'rgba(184,134,11,0.1)',
                  color: bed.type === 'grid' ? '#2d6a4f' : '#8a5a00',
                  border: bed.type === 'grid' ? '1px solid rgba(45,106,79,0.25)' : '1px solid rgba(184,134,11,0.25)',
                  flexShrink: 0,
                }}>
                  {bed.type === 'grid' ? 'Grid' : 'Freeform'}
                </span>

                {/* Name / edit */}
                {editingId === bed.id ? (
                  <input
                    autoFocus
                    value={editVal}
                    maxLength={30}
                    onChange={e => setEditVal(e.target.value)}
                    onBlur={() => commitEdit(bed)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') e.currentTarget.blur();
                      if (e.key === 'Escape') { setEditingId(null); }
                    }}
                    style={{
                      flex: 1, fontSize: 13, fontFamily: 'inherit',
                      border: 'none', borderBottom: '1px solid #2d6a4f',
                      background: 'transparent', outline: 'none', padding: '1px 0',
                    }}
                  />
                ) : (
                  <button
                    onClick={() => startEdit(bed)}
                    title="Click to rename"
                    style={{
                      flex: 1, textAlign: 'left', fontSize: 13, color: '#2c3e2c',
                      background: 'transparent', border: 'none', cursor: 'text',
                      padding: 0, fontFamily: 'inherit', overflow: 'hidden',
                      textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}
                  >
                    {bed.label || 'Untitled bed'}
                  </button>
                )}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 11, color: '#9a8e7e', flex: 1 }}>
                  {count} plant{count !== 1 ? 's' : ''}
                </span>
                <button onClick={() => onFocusBed(bed)} style={{
                  fontSize: 11, color: '#2d6a4f', background: 'transparent',
                  border: 'none', cursor: 'pointer', padding: '2px 0',
                  textDecoration: 'underline', textUnderlineOffset: 2,
                }}>
                  Go to bed
                </button>
                <button onClick={() => handleDelete(bed)} style={{
                  fontSize: 11, color: '#a04040', background: 'transparent',
                  border: 'none', cursor: 'pointer', padding: '2px 0',
                }}>
                  Delete
                </button>
              </div>

              {/* Inline confirm delete */}
              {confirmDeleteId === bed.id && (
                <div style={{ background: '#fff8f8', border: '1px solid #e8c8c8', borderRadius: 6, padding: '10px 12px' }}>
                  <div style={{ fontSize: 12, color: '#5a3030', marginBottom: 8 }}>
                    {count} plant{count !== 1 ? 's' : ''} will also be removed.
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={() => setConfirmDeleteId(null)} style={{ flex: 1, padding: '5px', borderRadius: 4, border: '1px solid #d8ceba', background: 'transparent', cursor: 'pointer', fontSize: 11 }}>
                      Cancel
                    </button>
                    <button onClick={() => { onDelete(bed.id); setConfirmDeleteId(null); }} style={{ flex: 1, padding: '5px', borderRadius: 4, border: 'none', background: '#c04040', color: '#fff', cursor: 'pointer', fontSize: 11 }}>
                      Delete
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
