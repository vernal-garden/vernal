import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useGardenList } from '../hooks/useGardenList';
import { useGarden } from '../hooks/useGarden';
import type { Bed, CreateBedPayload, UpdateBedPayload } from '../hooks/useGarden';
import { usePlantings } from '../hooks/usePlantings';
import type { Planting, ArmedSeed } from '../hooks/usePlantings';
import GardenCanvas from '../components/canvas/GardenCanvas';
import type { GardenCanvasRef } from '../components/canvas/GardenCanvas';
import BedDetailPanel from '../components/canvas/BedDetailPanel';
import BedManager from '../components/canvas/BedManager';
import CanvasToolbar from '../components/canvas/CanvasToolbar';
import type { CanvasMode } from '../components/canvas/CanvasToolbar';
import PlantPicker from '../components/canvas/PlantPicker';
import SeedForm from '../components/catalogue/SeedForm';
import type { PersonalSeedDetail } from '../types/catalogue';
import { useCompanions } from '../hooks/useCompanions';
import { useConflicts } from '../hooks/useConflicts';
import { computeBedOccupancy } from '../lib/crowding';

export default function HomePage() {
  const { gardens, loading: listLoading } = useGardenList();
  const [searchParams] = useSearchParams();
  const [activeId, setActiveId] = useState<string | null>(() => searchParams.get('garden'));
  const [selectedBed, setSelectedBed] = useState<Bed | null>(null);
  const [scale, setScale] = useState(1);
  const [mode, setMode] = useState<CanvasMode>('grid');
  const [panActive, setPanActive] = useState(false);
  const [bedManagerOpen, setBedManagerOpen] = useState(false);
  const [pendingMode, setPendingMode] = useState<CanvasMode | null>(null);
  const [detailFocusName, setDetailFocusName] = useState(false);
  const [overlapWarning, setOverlapWarning] = useState<string | null>(null);
  const overlapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canvasRef = useRef<GardenCanvasRef>(null);

  // Phase 19: plant picker + placement
  const [pickerOpen, setPickerOpen] = useState(false);
  const [armedSeed, setArmedSeed] = useState<ArmedSeed | null>(null);
  const [newSeedFormOpen, setNewSeedFormOpen] = useState(false);

  const resolvedId = activeId ?? (gardens.length > 0 ? gardens[0].id : null);
  const { garden, beds, loading: gardenLoading, mutationError, createBed, updateBed, deleteBed } = useGarden(resolvedId);
  const { plantingsByBedId, placePlanting, deletePlanting, latestPlacing, updatePlantingPoint } = usePlantings(resolvedId);

  // Phase 20: companion / conflict / occupancy
  const companionSeedIdsSet = useMemo(() => {
    const ids = new Set<string>();
    for (const plantings of Object.values(plantingsByBedId)) {
      for (const p of plantings) {
        if (p.companionSeedId) ids.add(p.companionSeedId);
      }
    }
    return ids;
  }, [plantingsByBedId]);

  const { relationshipBetween, ensureLoaded, cacheVersion } = useCompanions(companionSeedIdsSet);

  const { conflictedIds, conflictedBedIds } = useConflicts({
    beds,
    plantingsByBedId,
    relationshipBetween,
    cacheVersion,
  });

  const conflictJumpIndexRef = useRef(0);

  const handleJumpToConflict = useCallback(() => {
    const conflictBedArr = Array.from(conflictedBedIds);
    if (conflictBedArr.length === 0) return;
    const idx = conflictJumpIndexRef.current % conflictBedArr.length;
    conflictJumpIndexRef.current += 1;
    const bed = beds.find(b => b.id === conflictBedArr[idx]);
    if (bed) {
      canvasRef.current?.focusBed(bed);
      setSelectedBed(bed);
    }
  }, [conflictedBedIds, beds]);

  const occupancyByBedId = useMemo(() => {
    if (!garden) return {};
    const result: Record<string, { consumed: number; capacity: number; over: boolean }> = {};
    for (const bed of beds) {
      const plantings = plantingsByBedId[bed.id] ?? [];
      result[bed.id] = computeBedOccupancy({ garden, bed, plantings });
    }
    return result;
  }, [garden, beds, plantingsByBedId]);

  const bedCompanionIds = useMemo(() => {
    if (!selectedBed) return [];
    const plantings = plantingsByBedId[selectedBed.id] ?? [];
    return plantings.flatMap(p => (p.companionSeedId ? [p.companionSeedId] : []));
  }, [selectedBed, plantingsByBedId]);

  const selectedBedIsOver = selectedBed ? (occupancyByBedId[selectedBed.id]?.over ?? false) : false;

  // Keep selectedBed in sync when beds update
  useEffect(() => {
    if (!selectedBed) return;
    const fresh = beds.find(b => b.id === selectedBed.id);
    if (!fresh) setSelectedBed(null);
    else if (fresh !== selectedBed) setSelectedBed(fresh);
  }, [beds, selectedBed]);

  // Close picker when bed deselects
  useEffect(() => {
    if (!selectedBed) {
      setPickerOpen(false);
      setArmedSeed(null);
    }
  }, [selectedBed]);

  // Ensure companion data loaded when picker opens
  useEffect(() => {
    if (pickerOpen && selectedBed) {
      ensureLoaded(bedCompanionIds);
    }
  }, [pickerOpen, selectedBed, bedCompanionIds, ensureLoaded]);

  // Delete/Backspace keyboard shortcut for selected bed (0 plants only)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return;
      if ((e.code === 'Delete' || e.code === 'Backspace') && selectedBed) {
        e.preventDefault();
        if ((plantingsByBedId[selectedBed.id]?.length ?? 0) === 0) {
          deleteBed(selectedBed.id);
          setSelectedBed(null);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedBed, deleteBed, plantingsByBedId]);

  const handleGardenChange = useCallback((id: string) => {
    setActiveId(id);
    setSelectedBed(null);
    setBedManagerOpen(false);
    setPickerOpen(false);
    setArmedSeed(null);
  }, []);

  const handleSelectBed = useCallback((bed: Bed | null) => {
    setSelectedBed(bed);
    setDetailFocusName(false);
    if (bed) setBedManagerOpen(false);
    if (!bed) setPickerOpen(false);
  }, []);

  const handleDoubleBed = useCallback((bed: Bed) => {
    setSelectedBed(bed);
    setBedManagerOpen(false);
    setDetailFocusName(true);
    setPickerOpen(false);
    setArmedSeed(null);
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
    setPickerOpen(false);
    setArmedSeed(null);
  }, []);

  const handleCreateBed = useCallback((payload: CreateBedPayload) => {
    createBed(payload);
  }, [createBed]);

  const handleUpdateBedGeometry = useCallback((bedId: string, payload: UpdateBedPayload) => {
    // Remap freeform plantings' absolute points when the polygon changes (move or resize).
    // Grid plantings use relative cells and follow automatically — skip them.
    if ('freeform' in payload && payload.freeform) {
      const plantings = plantingsByBedId[bedId] ?? [];
      const withPoints = plantings.filter(p => p.point != null);
      if (withPoints.length > 0) {
        const oldBed = beds.find(b => b.id === bedId);
        const oldPts = oldBed?.freeform?.points;
        if (oldPts && oldPts.length >= 2) {
          // Compute old bbox
          let oldMinX = oldPts[0], oldMinY = oldPts[1], oldMaxX = oldPts[0], oldMaxY = oldPts[1];
          for (let i = 2; i < oldPts.length; i += 2) {
            if (oldPts[i] < oldMinX) oldMinX = oldPts[i];
            if (oldPts[i] > oldMaxX) oldMaxX = oldPts[i];
            if (oldPts[i + 1] < oldMinY) oldMinY = oldPts[i + 1];
            if (oldPts[i + 1] > oldMaxY) oldMaxY = oldPts[i + 1];
          }
          const oldW = oldMaxX - oldMinX;
          const oldH = oldMaxY - oldMinY;

          // Compute new bbox from payload
          const newPts = payload.freeform.points;
          let newMinX = newPts[0], newMinY = newPts[1], newMaxX = newPts[0], newMaxY = newPts[1];
          for (let i = 2; i < newPts.length; i += 2) {
            if (newPts[i] < newMinX) newMinX = newPts[i];
            if (newPts[i] > newMaxX) newMaxX = newPts[i];
            if (newPts[i + 1] < newMinY) newMinY = newPts[i + 1];
            if (newPts[i + 1] > newMaxY) newMaxY = newPts[i + 1];
          }
          const newW = newMaxX - newMinX;
          const newH = newMaxY - newMinY;

          for (const p of withPoints) {
            const nx = Math.round(newMinX + (p.point!.x - oldMinX) * (oldW > 0 ? newW / oldW : 1));
            const ny = Math.round(newMinY + (p.point!.y - oldMinY) * (oldH > 0 ? newH / oldH : 1));
            updatePlantingPoint(p.id, bedId, { x: nx, y: ny });
          }
        }
      }
    }
    updateBed(bedId, payload);
  }, [updateBed, plantingsByBedId, beds, updatePlantingPoint]);

  const handleOverlapWarning = useCallback((msg: string) => {
    setOverlapWarning(msg);
    if (overlapTimerRef.current) clearTimeout(overlapTimerRef.current);
    overlapTimerRef.current = setTimeout(() => setOverlapWarning(null), 3000);
  }, []);

  const handleFocusBed = useCallback((bed: Bed) => {
    canvasRef.current?.focusBed(bed);
    setBedManagerOpen(false);
    setSelectedBed(bed);
  }, []);

  const handleAddPlant = useCallback(() => {
    setPickerOpen(true);
    setArmedSeed(null);
  }, []);

  const handleDisarmSeed = useCallback(() => {
    setArmedSeed(null);
  }, []);

  const handleClosePicker = useCallback(() => {
    setPickerOpen(false);
    setArmedSeed(null);
  }, []);

  const handleConfirmPlacement = useCallback(async (
    bedId: string,
    cell: { x: number; y: number } | null,
    point: { x: number; y: number } | null,
    qty: number,
    date: string | null,
  ) => {
    if (!armedSeed) return;
    const seed = armedSeed;
    // Keep seed armed so the user can immediately place another
    const payload: {
      seedId?: string;
      cambiumSeedId?: string;
      cell?: { x: number; y: number };
      point?: { x: number; y: number };
      quantity?: number;
      plantingDate?: string;
    } = {
      quantity: qty,
      ...(date ? { plantingDate: date } : {}),
      ...(cell ? { cell } : {}),
      ...(point ? { point } : {}),
      ...(seed.source === 'catalogue' ? { cambiumSeedId: seed.id } : { seedId: seed.id }),
    };
    await placePlanting(bedId, payload, seed.commonName);
  }, [armedSeed, placePlanting]);

  const handleConfirmRemoval = useCallback(async (planting: Planting) => {
    await deletePlanting(planting.id, planting.bedId);
  }, [deletePlanting]);

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
        onOverlapWarning={handleOverlapWarning}
        garden={garden}
        plantingsByBedId={plantingsByBedId}
        armedSeed={armedSeed}
        onConfirmPlacement={handleConfirmPlacement}
        onConfirmRemoval={handleConfirmRemoval}
        conflictedIds={conflictedIds}
        conflictedBedIds={conflictedBedIds}
        latestPlacing={latestPlacing}
        occupancyByBedId={occupancyByBedId}
        relationshipBetween={relationshipBetween}
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

      {/* Placing banner */}
      {armedSeed && selectedBed && (
        <div style={{
          position: 'fixed', top: 16, left: '50%', transform: 'translateX(-50%)',
          background: '#1c3a28', color: '#d4edda', borderRadius: 8,
          padding: '10px 18px', fontSize: 13, zIndex: 99,
          boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
          whiteSpace: 'nowrap', pointerEvents: 'none',
        }}>
          Placing {armedSeed.commonName} — click inside &ldquo;{selectedBed.label}&rdquo; · Esc to cancel
        </div>
      )}

      {/* Mutation error / overlap warning toast */}
      {(mutationError || overlapWarning) && (
        <div style={{
          position: 'fixed', top: 16, left: '50%', transform: 'translateX(-50%)',
          background: '#5a1e1e', color: '#ffd8d8', borderRadius: 8,
          padding: '10px 18px', fontSize: 13, zIndex: 100,
          boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
        }}>
          {mutationError || overlapWarning}
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
          conflictCount={conflictedIds.size}
          onJumpToConflict={handleJumpToConflict}
        />
      )}

      {/* Bed detail panel (hidden when picker is open) */}
      {selectedBed && !pickerOpen && (
        <BedDetailPanel
          bed={selectedBed}
          plantingCount={plantingsByBedId[selectedBed.id]?.length ?? 0}
          onClose={handleCloseDetail}
          onRename={(label) => updateBed(selectedBed.id, { label })}
          onDelete={() => { deleteBed(selectedBed.id); setSelectedBed(null); }}
          focusName={detailFocusName}
          onAddPlant={handleAddPlant}
        />
      )}

      {/* Plant picker */}
      {pickerOpen && selectedBed && garden && (
        <PlantPicker
          garden={garden}
          bed={selectedBed}
          armedSeed={armedSeed}
          onArm={setArmedSeed}
          onDisarm={handleDisarmSeed}
          onClose={handleClosePicker}
          plantingsByBedId={plantingsByBedId}
          bedCompanionIds={bedCompanionIds}
          relationshipBetween={relationshipBetween}
          bedIsOver={selectedBedIsOver}
          onAddNewSeed={() => setNewSeedFormOpen(true)}
        />
      )}

      {newSeedFormOpen && (
        <SeedForm
          mode="add"
          onClose={() => setNewSeedFormOpen(false)}
          onSaved={(seed: PersonalSeedDetail) => {
            setNewSeedFormOpen(false);
            setArmedSeed({
              source: 'personal',
              id: seed.id,
              commonName: seed.commonName,
              spacingInches: seed.spacingInches ?? 6,
            });
          }}
        />
      )}

      {/* Bed manager */}
      {bedManagerOpen && resolvedId && (
        <BedManager
          beds={beds}
          plantingsByBedId={plantingsByBedId}
          onClose={() => setBedManagerOpen(false)}
          onRename={(bedId, label) => updateBed(bedId, { label })}
          onDelete={(bedId) => deleteBed(bedId)}
          onFocusBed={handleFocusBed}
        />
      )}
    </div>
  );
}
