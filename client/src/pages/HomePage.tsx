import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useGardenList } from '../hooks/useGardenList';
import { useGarden } from '../hooks/useGarden';
import type { Bed, CreateBedPayload, UpdateBedPayload } from '../hooks/useGarden';
import { usePlantings } from '../hooks/usePlantings';
import type { Planting, ArmedSeed, PlantingsByBedId } from '../hooks/usePlantings';
import { useGardenSeasons } from '../hooks/useGardenSeasons';
import GardenCanvas from '../components/canvas/GardenCanvas';
import type { GardenCanvasRef } from '../components/canvas/GardenCanvas';
import BedDetailPanel from '../components/canvas/BedDetailPanel';
import BedManager from '../components/canvas/BedManager';
import CanvasToolbar from '../components/canvas/CanvasToolbar';
import type { CanvasMode, SeasonOverlayStatus } from '../components/canvas/CanvasToolbar';
import { CanvasHomeButton } from '../components/canvas/CanvasHomeButton';
import PlantPicker from '../components/canvas/PlantPicker';
import SeedForm from '../components/catalogue/SeedForm';
import type { PersonalSeedDetail } from '../types/catalogue';
import { useCompanions } from '../hooks/useCompanions';
import { useConflicts } from '../hooks/useConflicts';
import { computeBedOccupancy } from '../lib/crowding';
import SupporterPromptModal from '../components/SupporterPromptModal';
import { track } from '../lib/track';
import { notifyPlantingPlaced } from '../lib/guestBannerEvents';
import { useMicroFeedback } from '../lib/microFeedback';
import * as api from '../lib/api';
import { useIsMobile } from '../hooks/useIsMobile';

// Garden ids that have already logged a canvas_session during this page load.
// Module-level so re-renders and StrictMode double effects can't fire it twice.
const trackedCanvasSessions = new Set<string>();

// How long after a successful placement a newly appearing conflict is still
// attributed to it. Companion data for the new seed can load after the POST.
const PLACEMENT_CONFLICT_WINDOW_MS = 10_000;

// Stable empties for the season overlay while it is off or loading.
const NO_OVERLAY_BEDS: Bed[] = [];
const NO_OVERLAY_PLANTINGS: PlantingsByBedId = {};

// Phase 50: "Start fresh" on the new-season prompt, per garden and season.
function carryForwardDismissKey(gardenId: string, season: number): string {
  return `vernal.carryForward.dismissed.${gardenId}.${season}`;
}

function readCarryForwardDismissed(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeCarryForwardDismissed(key: string): void {
  try {
    window.localStorage.setItem(key, '1');
  } catch {
    // Storage unavailable: the in-memory dismissal still hides the prompt.
  }
}

const CARRY_FORWARD_ERROR = 'Couldn’t bring your beds forward. Please try again.';

const promptButtonStyle: CSSProperties = {
  minHeight: 44, minWidth: 44, padding: '0 var(--sp-4)', borderRadius: 'var(--r-md)',
  fontFamily: 'var(--font-ui)', fontSize: 14, fontWeight: 600,
};

export default function HomePage() {
  const { gardens, loading: listLoading } = useGardenList();
  const { account, isAccount, markSupporterPromptShown } = useAuth();
  const requestFeedback = useMicroFeedback();
  const isMobile = useIsMobile();
  const navigate = useNavigate();
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

  // Phase 35: Supporter prompt
  const [supporterPromptOpen, setSupporterPromptOpen] = useState(false);

  const resolvedId = activeId ?? (gardens.length > 0 ? gardens[0].id : null);
  // Phase 50: one season for the whole page. Starts at currentSeasonPacific()
  // and follows the server's currentSeason once the season list loads.
  // gardenSeasons.refetch() reloads the season list (e.g. after carry-forward).
  const gardenSeasons = useGardenSeasons(resolvedId);
  const { currentSeason, earlierSeasons } = gardenSeasons;
  const {
    garden, beds, loading: gardenLoading, mutationError, createBed, updateBed, deleteBed,
    loadedKey: gardenLoadedKey, reload: reloadGarden,
  } = useGarden(resolvedId, currentSeason);
  const {
    plantingsByBedId, loading: plantingsLoading, placePlanting, deletePlanting, latestPlacing, updatePlantingPoint,
    loadedKey: plantingsLoadedKey, markStagesDisplayed, dismissIndicator,
  } = usePlantings(resolvedId, currentSeason);

  // Phase 50: past-season overlay. Component state only (never saved). Keyed
  // by garden so a garden switch hides it on the same render; the effect
  // below then clears it so switching back doesn't bring it back.
  const [overlay, setOverlay] = useState<{ gardenId: string; season: number } | null>(null);
  const overlaySeason = overlay && overlay.gardenId === resolvedId ? overlay.season : null;
  useEffect(() => { setOverlay(null); }, [resolvedId]);
  const overlaySeasonRef = useRef<number | null>(null);
  overlaySeasonRef.current = overlaySeason;
  // The same hooks as the current canvas, with a null garden id while the
  // overlay is off so nothing is fetched.
  const overlayGardenId = overlaySeason != null ? resolvedId : null;
  const overlayLoadSeason = overlaySeason ?? currentSeason;
  const {
    beds: overlayBedsRaw, loading: overlayBedsLoading, errorKey: overlayBedsErrorKey, loadedKey: overlayBedsKey,
  } = useGarden(overlayGardenId, overlayLoadSeason);
  const {
    plantingsByBedId: overlayPlantingsRaw, loading: overlayPlantingsLoading, errorKey: overlayPlantingsErrorKey,
    loadedKey: overlayPlantingsKey,
  } = usePlantings(overlayGardenId, overlayLoadSeason);
  const overlayKey = overlayGardenId ? `${overlayGardenId}:${overlayLoadSeason}` : null;
  const overlayReady = overlayKey != null
    && overlayBedsKey === overlayKey && overlayPlantingsKey === overlayKey
    && !overlayBedsLoading && !overlayPlantingsLoading;
  const overlayBeds = overlayReady ? overlayBedsRaw : NO_OVERLAY_BEDS;
  const overlayPlantingsByBedId = overlayReady ? overlayPlantingsRaw : NO_OVERLAY_PLANTINGS;
  const overlayStatus: SeasonOverlayStatus = overlaySeason == null ? 'off'
    : overlayReady ? (overlayBedsRaw.length === 0 ? 'empty' : 'ready')
    : overlayBedsErrorKey === overlayKey || overlayPlantingsErrorKey === overlayKey ? 'error'
    : 'loading';

  // Turns the overlay on for a past season (or off with null). Tracks once per
  // activation: only when the shown season actually changes to a past year.
  // Step 8 calls this after carrying a layout forward.
  const showSeasonOverlay = useCallback((season: number | null) => {
    if (!resolvedId) return;
    if (season == null || season >= currentSeason) {
      setOverlay(null);
      return;
    }
    if (overlaySeasonRef.current !== season) track('canvas_season_overlay');
    overlaySeasonRef.current = season;
    setOverlay({ gardenId: resolvedId, season });
  }, [resolvedId, currentSeason]);

  // Phase 50: new-season prompt. Offered when this season has no beds and an
  // earlier season has a layout. "Start fresh" hides it for this garden and
  // season; "Bring beds forward" copies the latest earlier layout.
  const latestEarlierSeason = earlierSeasons.length > 0 ? earlierSeasons[0] : null;
  const refetchSeasons = gardenSeasons.refetch;
  const [carryForward, setCarryForward] = useState<{ pending: boolean; error: string | null }>({ pending: false, error: null });
  const [dismissedCarryKeys, setDismissedCarryKeys] = useState<string[]>([]);
  // Synchronous double-click guard (buttons use aria-disabled, not disabled).
  const carryPendingRef = useRef(false);
  const resolvedIdRef = useRef(resolvedId);
  resolvedIdRef.current = resolvedId;
  useEffect(() => { setCarryForward({ pending: false, error: null }); }, [resolvedId]);

  const handleCarryForward = useCallback(async () => {
    if (!resolvedId || latestEarlierSeason == null) return;
    const gardenId = resolvedId;
    const fromSeason = latestEarlierSeason;
    if (carryPendingRef.current) return;
    carryPendingRef.current = true;
    setCarryForward({ pending: true, error: null });
    try {
      let alreadyHasBeds = false;
      try {
        await api.post(`/api/gardens/${gardenId}/beds/carry-forward`, { fromSeason });
      } catch (e) {
        const status = e instanceof api.ApiError ? e.status : null;
        if (status === 409) {
          alreadyHasBeds = true;
        } else if (status === 404 || status === 400) {
          // The earlier layout is gone (or the season is stale): refresh the list.
          if (resolvedIdRef.current !== gardenId) return;
          await refetchSeasons();
          if (resolvedIdRef.current !== gardenId) return;
          setCarryForward({ pending: false, error: 'Those beds are no longer there.' });
          return;
        } else {
          if (resolvedIdRef.current === gardenId) {
            setCarryForward({ pending: false, error: CARRY_FORWARD_ERROR });
          }
          return;
        }
      }
      // Garden switched mid-request: the new garden loads itself, and reloading
      // here would fetch the old garden into the current canvas.
      if (resolvedIdRef.current !== gardenId) return;
      const reloaded = await reloadGarden();
      await refetchSeasons();
      if (resolvedIdRef.current !== gardenId) return;
      if (!reloaded || reloaded.length === 0) {
        setCarryForward({ pending: false, error: CARRY_FORWARD_ERROR });
        return;
      }
      setCarryForward({ pending: false, error: null });
      if (!alreadyHasBeds) showSeasonOverlay(fromSeason);
    } finally {
      carryPendingRef.current = false;
    }
  }, [resolvedId, latestEarlierSeason, reloadGarden, refetchSeasons, showSeasonOverlay]);

  const handleStartFresh = useCallback(() => {
    if (!resolvedId || carryPendingRef.current) return;
    const key = carryForwardDismissKey(resolvedId, currentSeason);
    writeCarryForwardDismissed(key);
    setDismissedCarryKeys(keys => (keys.includes(key) ? keys : [...keys, key]));
  }, [resolvedId, currentSeason]);

  const carryDismissKey = resolvedId ? carryForwardDismissKey(resolvedId, currentSeason) : null;
  const carryDismissed = useMemo(
    () => carryDismissKey == null
      || dismissedCarryKeys.includes(carryDismissKey)
      || readCarryForwardDismissed(carryDismissKey),
    [carryDismissKey, dismissedCarryKeys],
  );

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

  // Phase 43: usage instrumentation
  useEffect(() => {
    if (resolvedId && !trackedCanvasSessions.has(resolvedId)) {
      trackedCanvasSessions.add(resolvedId);
      track('canvas_session');
    }
  }, [resolvedId]);

  // canvas_companion_warning: conflictedIds is snapshotted before a placement;
  // the first conflict id that appears outside the snapshot while the placement
  // is pending fires the event once. A garden switch cancels any pending check.
  const conflictSnapshotRef = useRef<Set<string>>(new Set());
  const pendingPlacementRef = useRef(false);
  const placementWindowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    pendingPlacementRef.current = false;
  }, [resolvedId]);

  useEffect(() => {
    if (!pendingPlacementRef.current) return;
    for (const id of conflictedIds) {
      if (!conflictSnapshotRef.current.has(id)) {
        pendingPlacementRef.current = false;
        track('canvas_companion_warning');
        return;
      }
    }
  }, [conflictedIds]);

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
    if (!fresh) { setSelectedBed(null); }
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

  const handleCreateBed = useCallback(async (payload: CreateBedPayload) => {
    const result = await createBed(payload);
    if (result) handleSelectBed(result);
  }, [createBed, handleSelectBed]);

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
    conflictSnapshotRef.current = new Set(conflictedIds);
    pendingPlacementRef.current = true;
    if (placementWindowTimerRef.current) clearTimeout(placementWindowTimerRef.current);
    const placed = await placePlanting(bedId, payload, seed.commonName);
    if (placed) {
      track('canvas_plant_placed');
      notifyPlantingPlaced();
      placementWindowTimerRef.current = setTimeout(() => {
        pendingPlacementRef.current = false;
      }, PLACEMENT_CONFLICT_WINDOW_MS);
    } else {
      pendingPlacementRef.current = false;
    }
    if (
      placed &&
      date &&
      account?.subscriptionTier === 'free' &&
      !account?.supporterPromptShown
    ) {
      setSupporterPromptOpen(true);
    } else if (placed) {
      requestFeedback('planted');
    }
  }, [armedSeed, placePlanting, account, conflictedIds, requestFeedback]);

  const handleConfirmRemoval = useCallback(async (planting: Planting) => {
    await deletePlanting(planting.id, planting.bedId);
  }, [deletePlanting]);

  const handleMarkHarvested = useCallback(async (planting: Planting) => {
    await dismissIndicator(planting.id, planting.bedId);
  }, [dismissIndicator]);

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
  // Only once both this season's beds and the garden's seasons have resolved,
  // so neither the prompt nor the plain instruction flashes ahead of the data.
  const emptyStateReady = hasNoBeds
    && resolvedId != null
    && gardenLoadedKey === `${resolvedId}:${currentSeason}`
    && gardenSeasons.loadedGardenId === resolvedId;
  const showNewSeasonPrompt = emptyStateReady && latestEarlierSeason != null && !carryDismissed;

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
        plantingsLoading={plantingsLoading}
        plantingsLoadedKey={plantingsLoadedKey}
        onStagesDisplayed={markStagesDisplayed}
        armedSeed={armedSeed}
        onConfirmPlacement={handleConfirmPlacement}
        onConfirmRemoval={handleConfirmRemoval}
        onMarkHarvested={handleMarkHarvested}
        conflictedIds={conflictedIds}
        conflictedBedIds={conflictedBedIds}
        latestPlacing={latestPlacing}
        occupancyByBedId={occupancyByBedId}
        relationshipBetween={relationshipBetween}
        overlayBeds={overlayBeds}
        overlayPlantingsByBedId={overlayPlantingsByBedId}
      />

      {/* Phase 50: new-season prompt (in place of the empty-beds instruction) */}
      {showNewSeasonPrompt && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          pointerEvents: 'none',
          padding: 'var(--sp-4)',
          // Keep clear of the shell bars and the bottom canvas toolbar.
          paddingTop: 'calc(var(--sp-4) + var(--shell-top, 0px))',
          paddingBottom: 'calc(96px + var(--shell-bottom, 0px))',
        }}>
          <section
            aria-labelledby="new-season-prompt-title"
            aria-live="polite"
            style={{
              pointerEvents: 'auto',
              width: '100%',
              maxWidth: 400,
              background: 'var(--c-surface)',
              border: '1px solid var(--c-border)',
              borderRadius: 'var(--r-lg)',
              padding: isMobile ? 'var(--sp-4)' : 'var(--sp-5)',
              boxShadow: 'var(--shadow-lg)',
              fontFamily: 'var(--font-ui)',
              color: 'var(--c-text)',
              textAlign: 'center',
            }}
          >
            <h2
              id="new-season-prompt-title"
              style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: isMobile ? 18 : 20, fontWeight: 600, color: 'var(--c-text)' }}
            >
              New season, same garden?
            </h2>
            <p style={{ margin: 'var(--sp-2) 0 0', fontSize: 14, lineHeight: 1.5, color: 'var(--c-text-2)' }}>
              Bring your beds forward from {latestEarlierSeason}. Your plants stay with {latestEarlierSeason}.
            </p>
            {carryForward.error && (
              <p role="alert" style={{ margin: 'var(--sp-3) 0 0', fontSize: 13, color: 'var(--c-danger)' }}>
                {carryForward.error}
              </p>
            )}
            <div style={{
              display: 'flex',
              flexDirection: isMobile ? 'column' : 'row',
              gap: 'var(--sp-2)',
              justifyContent: 'center',
              marginTop: 'var(--sp-4)',
            }}>
              <button
                type="button"
                onClick={handleCarryForward}
                aria-disabled={carryForward.pending}
                style={{
                  ...promptButtonStyle,
                  border: 'none',
                  background: 'var(--c-primary)',
                  color: 'var(--c-text-on-primary)',
                  cursor: carryForward.pending ? 'progress' : 'pointer',
                  opacity: carryForward.pending ? 0.7 : 1,
                }}
              >
                {carryForward.pending ? 'Bringing beds forward…' : 'Bring beds forward'}
              </button>
              <button
                type="button"
                onClick={handleStartFresh}
                aria-disabled={carryForward.pending}
                style={{
                  ...promptButtonStyle,
                  border: '1px solid var(--c-border)',
                  background: 'transparent',
                  color: 'var(--c-text)',
                  cursor: carryForward.pending ? 'default' : 'pointer',
                  opacity: carryForward.pending ? 0.7 : 1,
                }}
              >
                Start fresh
              </button>
            </div>
          </section>
        </div>
      )}

      {/* Empty-beds overlay */}
      {emptyStateReady && !showNewSeasonPrompt && (
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
          position: 'fixed', top: 'calc(16px + var(--shell-top, 0px))', left: '50%', transform: 'translateX(-50%)',
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
          position: 'fixed', top: 'calc(16px + var(--shell-top, 0px))', left: '50%', transform: 'translateX(-50%)',
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

      {/* Home anchor */}
      <CanvasHomeButton />

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
          currentSeason={currentSeason}
          earlierSeasons={earlierSeasons}
          overlaySeason={overlaySeason}
          overlayStatus={overlayStatus}
          onOverlaySeasonChange={showSeasonOverlay}
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
          gardenId={resolvedId}
          showDataLinks={isAccount}
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

      <SupporterPromptModal
        open={supporterPromptOpen}
        onClose={() => {
          markSupporterPromptShown();
          setSupporterPromptOpen(false);
        }}
        onLearnMore={() => {
          markSupporterPromptShown();
          setSupporterPromptOpen(false);
          navigate('/account');
        }}
      />
    </div>
  );
}
