import { useCallback, useEffect, useRef, useState } from 'react';
import { useGardenList } from '../hooks/useGardenList';
import { useGarden } from '../hooks/useGarden';
import type { Bed, CreateBedPayload, UpdateBedPayload } from '../hooks/useGarden';
import GardenCanvas from '../components/canvas/GardenCanvas';
import type { GardenCanvasRef } from '../components/canvas/GardenCanvas';
import BedDetailPanel from '../components/canvas/BedDetailPanel';
import BedManager from '../components/canvas/BedManager';
import CanvasToolbar from '../components/canvas/CanvasToolbar';
import type { CanvasMode } from '../components/canvas/CanvasToolbar';

export default function HomePage() {
  const { gardens, loading: listLoading } = useGardenList();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selectedBed, setSelectedBed] = useState<Bed | null>(null);
  const [scale, setScale] = useState(1);
  const [mode, setMode] = useState<CanvasMode>('grid');
  const [panActive, setPanActive] = useState(false);
  const [bedManagerOpen, setBedManagerOpen] = useState(false);
  const [pendingMode, setPendingMode] = useState<CanvasMode | null>(null);
  const [detailFocusName, setDetailFocusName] = useState(false);
  const canvasRef = useRef<GardenCanvasRef>(null);

  const resolvedId = activeId ?? (gardens.length > 0 ? gardens[0].id : null);
  const { garden, beds, loading: gardenLoading, mutationError, createBed, updateBed, deleteBed } = useGarden(resolvedId);

  // Keep selectedBed in sync when beds update (optimistic mutations change the object)
  useEffect(() => {
    if (!selectedBed) return;
    const fresh = beds.find(b => b.id === selectedBed.id);
    if (!fresh) setSelectedBed(null);
    else if (fresh !== selectedBed) setSelectedBed(fresh);
  }, [beds, selectedBed]);

  // Delete/Backspace keyboard shortcut for selected bed (0 plants only — >0 requires panel confirm)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return;
      if ((e.code === 'Delete' || e.code === 'Backspace') && selectedBed) {
        e.preventDefault();
        if (selectedBed.plantingCount === 0) {
          deleteBed(selectedBed.id);
          setSelectedBed(null);
        }
        // If plantingCount > 0, user must use the Delete button in the detail panel (shows confirm)
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedBed, deleteBed]);

  const handleGardenChange = useCallback((id: string) => {
    setActiveId(id);
    setSelectedBed(null);
    setBedManagerOpen(false);
  }, []);

  const handleSelectBed = useCallback((bed: Bed | null) => {
    setSelectedBed(bed);
    setDetailFocusName(false);
    if (bed) setBedManagerOpen(false);
  }, []);

  const handleDoubleBed = useCallback((bed: Bed) => {
    setSelectedBed(bed);
    setBedManagerOpen(false);
    setDetailFocusName(true);
  }, []);

  const handleZoomIn = useCallback(() => canvasRef.current?.zoomIn(), []);
  const handleZoomOut = useCallback(() => canvasRef.current?.zoomOut(), []);
  const handleResetZoom = useCallback(() => canvasRef.current?.resetZoom(), []);

  const handleModeChange = useCallback((next: CanvasMode) => {
    const otherType = next === 'grid' ? 'freeform' : 'grid';
    const hasOtherBeds = beds.some(b => b.type === otherType);
    if (hasOtherBeds) {
      setPendingMode(next);
    } else {
      setMode(next);
    }
  }, [beds]);

  const handlePanToggle = useCallback(() => setPanActive(p => !p), []);

  const handleBedManagerToggle = useCallback(() => {
    setBedManagerOpen(o => {
      if (!o) setSelectedBed(null);
      return !o;
    });
  }, []);

  const handleCloseDetail = useCallback(() => {
    setSelectedBed(null);
    setDetailFocusName(false);
  }, []);

  const handleCreateBed = useCallback((payload: CreateBedPayload) => {
    createBed(payload);
  }, [createBed]);

  const handleUpdateBedGeometry = useCallback((bedId: string, payload: UpdateBedPayload) => {
    updateBed(bedId, payload);
  }, [updateBed]);

  const handleFocusBed = useCallback((bed: Bed) => {
    canvasRef.current?.focusBed(bed);
    setBedManagerOpen(false);
    setSelectedBed(bed);
  }, []);

  if (listLoading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#f8f4eb' }}>
        <div style={{ width: 32, height: 32, border: '2px solid #c8dcca', borderTopColor: '#2d6a4f', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  if (!listLoading && gardens.length === 0) return null;

  const hasNoBeds = !gardenLoading && garden != null && beds.length === 0;

  return (
    <div style={{ position: 'relative', width: '100vw', height: '100vh', background: '#f8f4eb', overflow: 'hidden' }}>
      {/* Canvas */}
      <GardenCanvas
        ref={canvasRef}
        beds={beds}
        selectedBedId={selectedBed?.id ?? null}
        onSelectBed={handleSelectBed}
        onDoubleBed={handleDoubleBed}
        onScaleChange={setScale}
        mode={mode}
        panActive={panActive}
        gardenId={resolvedId ?? ''}
        onCreateBed={handleCreateBed}
        onUpdateBedGeometry={handleUpdateBedGeometry}
      />

      {/* Empty-beds overlay */}
      {hasNoBeds && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
          <div style={{
            background: 'rgba(250, 247, 242, 0.88)',
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
            border: '1px solid #d8ceba',
            borderRadius: 12,
            padding: '18px 28px',
            fontFamily: "'Fraunces', Georgia, serif",
            fontSize: 15,
            color: '#5a4e3a',
            boxShadow: '0 4px 20px rgba(0,0,0,0.08)',
            textAlign: 'center',
            lineHeight: 1.6,
          }}>
            Select <strong>Grid</strong> or <strong>Freeform</strong> in the toolbar,<br />
            then draw on the canvas to place your first bed.
          </div>
        </div>
      )}

      {/* Mutation error toast */}
      {mutationError && (
        <div style={{
          position: 'fixed', top: 16, left: '50%', transform: 'translateX(-50%)',
          background: '#5a1e1e', color: '#ffd8d8', borderRadius: 8,
          padding: '10px 18px', fontSize: 13, zIndex: 100,
          boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
        }}>
          {mutationError}
        </div>
      )}

      {/* Mode-switch confirm */}
      {pendingMode && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 50,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{
            background: '#faf7f2', borderRadius: 12, padding: '24px 28px', maxWidth: 360,
            border: '1px solid #d8ceba', boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
            fontFamily: 'system-ui, -apple-system, sans-serif',
          }}>
            <div style={{ fontSize: 15, color: '#2c3e2c', marginBottom: 12 }}>
              Switching to <strong>{pendingMode === 'grid' ? 'Grid' : 'Freeform'}</strong> mode won't affect your existing beds.
              New beds will be {pendingMode === 'grid' ? 'grid' : 'freeform'}.
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setPendingMode(null)}
                style={{ padding: '7px 16px', borderRadius: 6, border: '1px solid #d8ceba', background: 'transparent', cursor: 'pointer', fontSize: 13 }}
              >
                Cancel
              </button>
              <button
                onClick={() => { setMode(pendingMode); setPendingMode(null); }}
                style={{ padding: '7px 16px', borderRadius: 6, border: 'none', background: '#2d6a4f', color: '#fff', cursor: 'pointer', fontSize: 13 }}
              >
                Continue
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toolbar */}
      {resolvedId && (
        <CanvasToolbar
          scale={scale}
          onZoomIn={handleZoomIn}
          onZoomOut={handleZoomOut}
          onResetZoom={handleResetZoom}
          gardens={gardens}
          activeGardenId={resolvedId}
          onGardenChange={handleGardenChange}
          mode={mode}
          onModeChange={handleModeChange}
          panActive={panActive}
          onPanToggle={handlePanToggle}
          bedManagerOpen={bedManagerOpen}
          onBedManagerToggle={handleBedManagerToggle}
        />
      )}

      {/* Bed detail panel */}
      {selectedBed && (
        <BedDetailPanel
          bed={selectedBed}
          onClose={handleCloseDetail}
          onRename={(label) => updateBed(selectedBed.id, { label })}
          onDelete={() => { deleteBed(selectedBed.id); setSelectedBed(null); }}
          focusName={detailFocusName}
        />
      )}

      {/* Bed manager */}
      {bedManagerOpen && resolvedId && (
        <BedManager
          beds={beds}
          onClose={() => setBedManagerOpen(false)}
          onRename={(bedId, label) => updateBed(bedId, { label })}
          onDelete={(bedId) => deleteBed(bedId)}
          onFocusBed={handleFocusBed}
        />
      )}
    </div>
  );
}
