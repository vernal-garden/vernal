import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, get } from '../../lib/api';
import { compressImage } from '../../lib/imageCompress';
import { parseDay, todayPacific } from '../../lib/guideDates';
import { track } from '../../lib/track';
import { useMicroFeedback } from '../../lib/microFeedback';
import { useAuth } from '../../context/AuthContext';
import { useGardenList } from '../../hooks/useGardenList';
import {
  createHarvest,
  deleteHarvest,
  fetchPlantOptions,
  getHarvest,
  removeHarvestPhoto,
  seedParamOf,
  updateHarvest,
  uploadHarvestPhoto,
} from '../../hooks/useHarvests';
import type {
  HarvestEntry,
  HarvestInput,
  HarvestPhoto,
  HarvestUnit,
  SeedParam,
  WeightUnit,
} from '../../types/harvest';
import BottomSheet from '../shell/BottomSheet';
import { CloseIcon } from '../shell/icons';
import HarvestModal from './HarvestModal';
import PlantSearch from './PlantSearch';
import DeleteHarvestDialog from './DeleteHarvestDialog';
import {
  fieldErrorStyle,
  fieldStyle,
  iconButtonStyle,
  inputStyle,
  labelStyle,
  primaryButtonStyle,
  secondaryTextStyle,
  segmentGroupStyle,
  segmentStyle,
  spinnerStyle,
  textButtonStyle,
  textLinkButtonStyle,
} from './formStyles';

export type FormMode =
  | { kind: 'new'; gardenId: string | null; seed: SeedParam | null }
  | { kind: 'edit'; entryId: string };

export interface FormResult {
  entryId: string;
  created: boolean;
  photoFailures: number;
  storageUnavailable: boolean;
}

interface Props {
  mode: FormMode;
  isMobile: boolean;
  // The garden filter, used as an editable default for new entries.
  defaultGardenId: string | null;
  onClose: () => void;
  onSaved: (result: FormResult) => void;
  onDeleted: (entryId: string) => void;
}

interface Plant {
  seedId: string | null;
  cambiumSeedId: string | null;
  commonName: string | null;
  scientificName: string | null;
}

interface Bed {
  id: string;
  label: string;
}

interface NewPhoto {
  id: number;
  blob: Blob;
  url: string;
}

const UNIT_KEY = 'vernal.harvest.unit';
const WEIGHT_UNITS: WeightUnit[] = ['g', 'kg', 'oz', 'lb'];
const MAX_PHOTOS = 3;
const PLANT_REQUIRED = 'Which plant did you harvest?';

function readStoredUnit(): HarvestUnit {
  try {
    const v = window.localStorage.getItem(UNIT_KEY);
    if (v === 'count' || WEIGHT_UNITS.includes(v as WeightUnit)) return v as HarvestUnit;
  } catch {
    // storage unavailable
  }
  return 'lb';
}

function storeUnit(unit: HarvestUnit): void {
  try {
    window.localStorage.setItem(UNIT_KEY, unit);
  } catch {
    // storage unavailable — the default stays lb
  }
}

function plantFromParam(seed: SeedParam): Plant {
  const [kind, id] = seed.split(':');
  return kind === 'seed'
    ? { seedId: id, cambiumSeedId: null, commonName: null, scientificName: null }
    : { seedId: null, cambiumSeedId: id, commonName: null, scientificName: null };
}

function seedBody(p: Plant): Pick<HarvestInput, 'seedId' | 'cambiumSeedId'> {
  return p.seedId !== null
    ? { seedId: Number(p.seedId), cambiumSeedId: null }
    : { seedId: null, cambiumSeedId: Number(p.cambiumSeedId) };
}

let nextPhotoId = 1;

export default function HarvestEntryForm({ mode, isMobile, defaultGardenId, onClose, onSaved, onDeleted }: Props) {
  const { isGuest, isAccount, account } = useAuth();
  const requestFeedback = useMicroFeedback();
  const { gardens, loading: gardensLoading } = useGardenList();
  const uid = useId();
  const today = todayPacific();
  const isEdit = mode.kind === 'edit';
  const title = isEdit ? 'Edit harvest' : 'Log harvest';

  // ── Edit: load the entry ────────────────────────────────────────────────────
  const [entry, setEntry] = useState<HarvestEntry | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'missing' | 'error'>(isEdit ? 'loading' : 'ready');

  // ── Fields ──────────────────────────────────────────────────────────────────
  const prefillSeed = mode.kind === 'new' ? mode.seed : null;
  const prefillGarden = mode.kind === 'new' ? mode.gardenId : null;

  const [plant, setPlant] = useState<Plant | null>(prefillSeed ? plantFromParam(prefillSeed) : null);
  const [plantLocked, setPlantLocked] = useState(prefillSeed !== null);
  const [plantError, setPlantError] = useState(false);
  const [plantSheetOpen, setPlantSheetOpen] = useState(false);

  const [gardenId, setGardenId] = useState<string | null>(null);
  const [gardenLocked, setGardenLocked] = useState(prefillGarden !== null);
  const [beds, setBeds] = useState<Bed[]>([]);
  const [bedId, setBedId] = useState('');
  const [date, setDate] = useState(today);

  const storedUnit = useRef(readStoredUnit()).current;
  const [quantity, setQuantity] = useState('');
  const [measure, setMeasure] = useState<'weight' | 'count'>(storedUnit === 'count' ? 'count' : 'weight');
  const [weightUnit, setWeightUnit] = useState<WeightUnit>(storedUnit === 'count' ? 'lb' : storedUnit);
  const [rating, setRating] = useState<number | null>(null);
  const [notes, setNotes] = useState('');

  const [existingPhotos, setExistingPhotos] = useState<HarvestPhoto[]>([]);
  const [removedKeys, setRemovedKeys] = useState<string[]>([]);
  const [newPhotos, setNewPhotos] = useState<NewPhoto[]>([]);
  const [photoMessage, setPhotoMessage] = useState<string | null>(null);
  const [tierNoticeDismissed, setTierNoticeDismissed] = useState(false);

  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const plantInputRef = useRef<HTMLInputElement>(null);
  const plantButtonRef = useRef<HTMLButtonElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const editId = mode.kind === 'edit' ? mode.entryId : null;
  useEffect(() => {
    if (editId === null) return;
    let cancelled = false;
    getHarvest(editId)
      .then((e) => {
        if (cancelled) return;
        setEntry(e);
        setPlant({ seedId: e.seedId, cambiumSeedId: e.cambiumSeedId, commonName: e.commonName, scientificName: e.scientificName });
        setPlantLocked(true);
        setGardenId(e.gardenId);
        setBedId(e.bedId ?? '');
        setDate(e.harvestDate);
        setQuantity(e.quantity === null ? '' : String(e.quantity));
        if (e.unit === 'count') setMeasure('count');
        else if (e.unit) {
          setMeasure('weight');
          setWeightUnit(e.unit);
        }
        setRating(e.qualityRating);
        setNotes(e.notes ?? '');
        setExistingPhotos(e.photos);
        setLoadState('ready');
      })
      .catch((err) => {
        if (!cancelled) setLoadState(err instanceof ApiError && (err.status === 404 || err.status === 400) ? 'missing' : 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [editId]);

  // Prefilled plant: look up its names.
  useEffect(() => {
    if (!prefillSeed) return;
    let cancelled = false;
    fetchPlantOptions('')
      .then((options) => {
        const match = options.find((o) => seedParamOf(o) === prefillSeed);
        if (!cancelled && match) {
          setPlant((p) => (p && seedParamOf(p) === prefillSeed ? { ...p, commonName: match.commonName, scientificName: match.scientificName } : p));
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [prefillSeed]);

  // Default garden: the prefilled one, else the filter's, else the most recently used.
  useEffect(() => {
    if (isEdit || gardenId !== null || gardens.length === 0) return;
    const known = (id: string | null) => (id && gardens.some((g) => g.id === id) ? id : null);
    const pre = known(prefillGarden);
    if (!pre) setGardenLocked(false);
    setGardenId(pre ?? known(defaultGardenId) ?? gardens[0].id);
  }, [gardens, gardenId, isEdit, prefillGarden, defaultGardenId]);

  // Beds for the garden and the season of the chosen date.
  const year = /^\d{4}-\d{2}-\d{2}$/.test(date) ? parseDay(date).y : parseDay(today).y;
  useEffect(() => {
    if (!gardenId) return;
    let cancelled = false;
    get<{ data: Bed[] }>(`/api/gardens/${gardenId}/beds?season=${year}`)
      .then((res) => {
        if (cancelled) return;
        const list = res?.data ?? [];
        setBeds(list);
        setBedId((current) => (current && !list.some((b) => b.id === current) ? '' : current));
      })
      .catch(() => {
        if (!cancelled) setBeds([]);
      });
    return () => {
      cancelled = true;
    };
  }, [gardenId, year]);

  // Body scroll lock for the full-screen mobile view (the modal locks its own).
  useEffect(() => {
    if (!isMobile) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [isMobile]);

  // Revoke preview URLs on unmount.
  const newPhotosRef = useRef(newPhotos);
  newPhotosRef.current = newPhotos;
  useEffect(() => () => newPhotosRef.current.forEach((p) => URL.revokeObjectURL(p.url)), []);

  // ── Photos ──────────────────────────────────────────────────────────────────
  const keptPhotos = existingPhotos.filter((p) => !removedKeys.includes(p.key));
  const photoCount = keptPhotos.length + newPhotos.length;
  const isSupporter = account?.subscriptionTier === 'supporter';

  async function addFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setPhotoMessage(null);
    const room = MAX_PHOTOS - photoCount;
    const chosen = Array.from(files);
    if (chosen.length > room) setPhotoMessage('Up to 3 photos per harvest.');
    const added: NewPhoto[] = [];
    for (const file of chosen.slice(0, Math.max(0, room))) {
      try {
        const blob = await compressImage(file);
        added.push({ id: nextPhotoId++, blob, url: URL.createObjectURL(blob) });
      } catch {
        setPhotoMessage("That photo couldn't be read.");
      }
    }
    setNewPhotos((prev) => [...prev, ...added]);
    if (fileRef.current) fileRef.current.value = '';
  }

  function removeNewPhoto(id: number) {
    setNewPhotos((prev) => {
      const gone = prev.find((p) => p.id === id);
      if (gone) URL.revokeObjectURL(gone.url);
      return prev.filter((p) => p.id !== id);
    });
  }

  // ── Save ────────────────────────────────────────────────────────────────────
  async function save() {
    if (saving) return;
    setServerError(null);
    if (!plant) {
      setPlantError(true);
      (isMobile ? plantButtonRef.current : plantInputRef.current)?.focus();
      return;
    }
    if (!gardenId) {
      setServerError('Create a garden before logging a harvest.');
      return;
    }

    const qtyText = quantity.trim();
    const qty = qtyText === '' ? null : Number(qtyText);
    if (qty !== null && !Number.isFinite(qty)) {
      setServerError('Enter the quantity as a number.');
      return;
    }
    const unit: HarvestUnit | null = qty === null ? null : measure === 'count' ? 'count' : weightUnit;
    const trimmedNotes = notes.trim() || null;
    const bed = bedId === '' ? null : Number(bedId);

    setSaving(true);
    let saved: HarvestEntry;
    try {
      if (mode.kind === 'new') {
        saved = await createHarvest({
          gardenId: Number(gardenId),
          ...seedBody(plant),
          bedId: bed,
          harvestDate: date,
          quantity: qty,
          unit,
          qualityRating: rating,
          notes: trimmedNotes,
        });
      } else {
        const e = entry!;
        const changes: HarvestInput = {};
        if (gardenId !== e.gardenId) changes.gardenId = Number(gardenId);
        if (seedParamOf(plant) !== seedParamOf(e)) Object.assign(changes, seedBody(plant));
        if ((bedId || null) !== e.bedId || gardenId !== e.gardenId) changes.bedId = bed;
        if (date !== e.harvestDate) changes.harvestDate = date;
        if (qty !== e.quantity || unit !== e.unit) {
          changes.quantity = qty;
          changes.unit = unit;
        }
        if (rating !== e.qualityRating) changes.qualityRating = rating;
        if (trimmedNotes !== (e.notes ?? null)) changes.notes = trimmedNotes;
        saved = Object.keys(changes).length > 0 ? await updateHarvest(e.id, changes) : e;
      }
    } catch (err) {
      const body = err instanceof ApiError ? (err.body as { error?: unknown } | null) : null;
      setServerError(
        err instanceof ApiError && err.status === 400 && typeof body?.error === 'string'
          ? body.error
          : "Couldn't save your harvest. Try again.",
      );
      setSaving(false);
      return;
    }

    let photoFailures = 0;
    let storageUnavailable = false;
    const failed = (err: unknown) => {
      photoFailures++;
      if (err instanceof ApiError && err.status === 503) storageUnavailable = true;
    };
    for (const key of removedKeys) {
      try {
        await removeHarvestPhoto(saved.id, key);
      } catch (err) {
        failed(err);
      }
    }
    for (const photo of newPhotos) {
      try {
        await uploadHarvestPhoto(saved.id, photo.blob);
      } catch (err) {
        failed(err);
      }
    }

    if (qty !== null && unit) storeUnit(unit);
    if (mode.kind === 'new') {
      track('harvest_entry_saved');
      requestFeedback('harvest_logged');
    }
    setSaving(false);
    onSaved({ entryId: saved.id, created: mode.kind === 'new', photoFailures, storageUnavailable });
  }

  async function confirmDeleteEntry() {
    if (!entry) return;
    await deleteHarvest(entry.id);
    onDeleted(entry.id);
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  const plantErrorId = `${uid}-plant-error`;
  const selectedGarden = gardens.find((g) => g.id === gardenId);

  const plantField = (
    <div style={fieldStyle}>
      <label htmlFor={`${uid}-plant`} style={labelStyle}>Plant</label>
      {plant && plantLocked ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)' }}>
          <div style={{ flex: 1, minWidth: 0 }} id={`${uid}-plant`}>
            <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--c-text)' }}>{plant.commonName ?? 'Selected plant'}</div>
            {plant.scientificName && (
              <div style={{ ...secondaryTextStyle, fontStyle: 'italic' }}>{plant.scientificName}</div>
            )}
          </div>
          <button type="button" onClick={() => { setPlantLocked(false); setPlant(null); }} style={textLinkButtonStyle}>
            Change
          </button>
        </div>
      ) : isMobile ? (
        <button
          ref={plantButtonRef}
          id={`${uid}-plant`}
          type="button"
          aria-invalid={plantError || undefined}
          aria-describedby={plantError ? plantErrorId : undefined}
          onClick={() => setPlantSheetOpen(true)}
          style={{
            ...inputStyle,
            textAlign: 'left',
            cursor: 'pointer',
            borderColor: plantError ? 'var(--c-danger)' : 'var(--c-border)',
            color: plant ? 'var(--c-text)' : 'var(--c-text-3)',
          }}
        >
          {plant ? plant.commonName ?? 'Selected plant' : 'Choose a plant'}
        </button>
      ) : plant ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)' }}>
          <div style={{ flex: 1, minWidth: 0 }} id={`${uid}-plant`}>
            <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--c-text)' }}>{plant.commonName ?? 'Selected plant'}</div>
            {plant.scientificName && <div style={{ ...secondaryTextStyle, fontStyle: 'italic' }}>{plant.scientificName}</div>}
          </div>
          <button type="button" onClick={() => setPlant(null)} style={textLinkButtonStyle}>Change</button>
        </div>
      ) : (
        <PlantSearch
          variant="combobox"
          label="Plant"
          inputRef={plantInputRef}
          invalid={plantError}
          describedBy={plantError ? plantErrorId : undefined}
          onSelect={(o) => {
            setPlant(o);
            setPlantError(false);
          }}
        />
      )}
      {plantError && !plant && (
        <p id={plantErrorId} style={fieldErrorStyle}>{PLANT_REQUIRED}</p>
      )}
    </div>
  );

  const gardenField = (
    <div style={fieldStyle}>
      <label htmlFor={`${uid}-garden`} style={labelStyle}>Garden</label>
      {gardensLoading && gardens.length === 0 ? (
        <div style={secondaryTextStyle}>Loading…</div>
      ) : gardens.length === 0 ? (
        <div style={secondaryTextStyle}>You don&rsquo;t have a garden yet.</div>
      ) : gardens.length === 1 || gardenLocked ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)', minHeight: 44 }}>
          <span id={`${uid}-garden`} style={{ flex: 1, fontSize: 16, color: 'var(--c-text)' }}>
            {selectedGarden?.name ?? '…'}
          </span>
          {gardens.length > 1 && (
            <button type="button" onClick={() => setGardenLocked(false)} style={textLinkButtonStyle}>Change</button>
          )}
        </div>
      ) : (
        <select
          id={`${uid}-garden`}
          value={gardenId ?? ''}
          onChange={(e) => setGardenId(e.target.value)}
          style={inputStyle}
        >
          {gardens.map((g) => (
            <option key={g.id} value={g.id}>{g.name}</option>
          ))}
        </select>
      )}
    </div>
  );

  const fields = (
    <>
      {plantField}
      {gardenField}

      <div style={fieldStyle}>
        <label htmlFor={`${uid}-bed`} style={labelStyle}>Bed</label>
        <select id={`${uid}-bed`} value={bedId} onChange={(e) => setBedId(e.target.value)} style={inputStyle}>
          <option value="">No specific bed</option>
          {beds.map((b) => (
            <option key={b.id} value={b.id}>{b.label.trim() || 'Unnamed bed'}</option>
          ))}
        </select>
      </div>

      <div style={fieldStyle}>
        <label htmlFor={`${uid}-date`} style={labelStyle}>Date</label>
        <input
          id={`${uid}-date`}
          type="date"
          value={date}
          max={today}
          onChange={(e) => setDate(e.target.value || today)}
          style={inputStyle}
        />
      </div>

      <div style={fieldStyle}>
        <label htmlFor={`${uid}-qty`} style={labelStyle}>Quantity</label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--sp-2)', alignItems: 'center' }}>
          <input
            id={`${uid}-qty`}
            type="number"
            inputMode="decimal"
            min={0}
            step="any"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            placeholder="Optional"
            style={{ ...inputStyle, width: 120, flex: '0 0 auto' }}
          />
          <div role="group" aria-label="Measure" style={segmentGroupStyle}>
            <button type="button" aria-pressed={measure === 'weight'} onClick={() => setMeasure('weight')} style={segmentStyle(measure === 'weight')}>
              Weight
            </button>
            <button type="button" aria-pressed={measure === 'count'} onClick={() => setMeasure('count')} style={segmentStyle(measure === 'count')}>
              Count
            </button>
          </div>
          {measure === 'weight' && (
            <select
              aria-label="Unit"
              value={weightUnit}
              onChange={(e) => setWeightUnit(e.target.value as WeightUnit)}
              style={{ ...inputStyle, width: 'auto', minWidth: 72 }}
            >
              {WEIGHT_UNITS.map((u) => (
                <option key={u} value={u}>{u}</option>
              ))}
            </select>
          )}
        </div>
      </div>

      <div style={fieldStyle}>
        <span id={`${uid}-quality`} style={labelStyle}>Quality</span>
        <div role="group" aria-labelledby={`${uid}-quality`} style={{ display: 'flex', gap: 2 }}>
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              aria-label={n === 1 ? '1 star' : `${n} stars`}
              aria-pressed={rating === n}
              onClick={() => setRating(rating === n ? null : n)}
              style={{
                ...iconButtonStyle,
                fontSize: 24,
                color: rating !== null && n <= rating ? 'var(--c-warning)' : 'var(--c-border)',
              }}
            >
              <span aria-hidden="true">★</span>
            </button>
          ))}
        </div>
      </div>

      <div style={fieldStyle}>
        <label htmlFor={`${uid}-notes`} style={labelStyle}>Notes</label>
        <textarea
          id={`${uid}-notes`}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="How did it look? Any surprises?"
          rows={3}
          maxLength={5000}
          style={{ ...inputStyle, minHeight: 88, padding: 'var(--sp-2) var(--sp-3)', resize: 'vertical' }}
        />
      </div>

      <div style={fieldStyle}>
        <span style={labelStyle}>Photos</span>
        {isSupporter ? (
          <>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--sp-2)', marginBottom: 'var(--sp-2)' }}>
              {keptPhotos.map((p) => (
                <Thumb key={p.key} url={p.url} onRemove={() => setRemovedKeys((k) => [...k, p.key])} />
              ))}
              {newPhotos.map((p) => (
                <Thumb key={p.id} url={p.url} onRemove={() => removeNewPhoto(p.id)} />
              ))}
            </div>
            {photoCount < MAX_PHOTOS && (
              <button type="button" onClick={() => fileRef.current?.click()} style={textButtonStyle}>
                Add photo
              </button>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              capture="environment"
              multiple
              hidden
              onChange={(e) => void addFiles(e.target.files)}
            />
            {photoMessage && <p role="status" style={{ ...secondaryTextStyle, margin: 'var(--sp-2) 0 0' }}>{photoMessage}</p>}
          </>
        ) : (
          <>
            {/* Free accounts keep photos added while a Supporter: remove only, no add. */}
            {isAccount && existingPhotos.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--sp-2)', marginBottom: 'var(--sp-2)' }}>
                {keptPhotos.map((p) => (
                  <Thumb key={p.key} url={p.url} onRemove={() => setRemovedKeys((k) => [...k, p.key])} />
                ))}
              </div>
            )}
            {!tierNoticeDismissed && (
              <TierNotice
                onDismiss={() => setTierNoticeDismissed(true)}
                text={
                  isGuest
                    ? 'Photos are part of the Supporter tier. Sign in and become a Supporter to attach photos.'
                    : 'Photos are part of the Supporter tier. Upgrade to attach photos to your harvest entries.'
                }
                link={isGuest ? { to: '/login', label: 'Sign in' } : { to: '/account', label: 'Upgrade' }}
              />
            )}
          </>
        )}
      </div>
    </>
  );

  const errorLine = serverError && (
    <p role="alert" style={{ ...fieldErrorStyle, margin: '0 0 var(--sp-3)' }}>{serverError}</p>
  );

  let content: ReactNode;
  if (loadState === 'loading') {
    content = (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--sp-7) 0' }}>
        <div style={spinnerStyle} />
      </div>
    );
  } else if (loadState === 'missing' || loadState === 'error') {
    content = (
      <p style={{ ...secondaryTextStyle, fontSize: 15, padding: 'var(--sp-5) 0' }}>
        {loadState === 'missing' ? "This harvest entry wasn't found." : "Couldn't load this harvest. Try again."}
      </p>
    );
  } else {
    content = fields;
  }
  const ready = loadState === 'ready';

  const plantSheet = isMobile && (
    <BottomSheet open={plantSheetOpen} onClose={() => setPlantSheetOpen(false)} title="Choose a plant">
      <div style={{ padding: '0 var(--sp-4) var(--sp-4)' }}>
        <PlantSearch
          variant="list"
          label="Search plants"
          autoFocus
          onSelect={(o) => {
            setPlant(o);
            setPlantError(false);
            setPlantSheetOpen(false);
          }}
        />
      </div>
    </BottomSheet>
  );

  const deleteDialog = confirmDelete && (
    <DeleteHarvestDialog isMobile={isMobile} onCancel={() => setConfirmDelete(false)} onConfirm={confirmDeleteEntry} />
  );

  if (isMobile) {
    return (
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 1050,
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--c-surface)',
          fontFamily: 'var(--font-ui)',
          paddingTop: 'env(safe-area-inset-top)',
          paddingLeft: 'env(safe-area-inset-left)',
          paddingRight: 'env(safe-area-inset-right)',
        }}
      >
        <header
          style={{
            flexShrink: 0,
            height: 52,
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--sp-2)',
            padding: '0 var(--sp-2) 0 var(--sp-1)',
            borderBottom: '1px solid var(--c-border-subtle)',
          }}
        >
          <button type="button" aria-label="Cancel" onClick={onClose} style={iconButtonStyle}>
            <CloseIcon />
          </button>
          <h2 style={{ flex: 1, margin: 0, fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 600, color: 'var(--c-text)' }}>
            {title}
          </h2>
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || !ready}
            style={{ ...primaryButtonStyle, opacity: saving || !ready ? 0.6 : 1 }}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </header>
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            padding: 'var(--sp-4)',
            paddingBottom: 'calc(var(--sp-6) + env(safe-area-inset-bottom))',
          }}
        >
          {errorLine}
          {content}
          {isEdit && ready && (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              style={{ ...textLinkButtonStyle, color: 'var(--c-danger)', marginTop: 'var(--sp-2)' }}
            >
              Delete harvest
            </button>
          )}
        </div>
        {plantSheet}
        {deleteDialog}
      </div>
    );
  }

  return (
    <HarvestModal ariaLabel={title} onClose={onClose}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)', padding: 'var(--sp-4) var(--sp-4) 0 var(--sp-5)' }}>
        <h2 style={{ flex: 1, margin: 0, fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 600, color: 'var(--c-text)' }}>
          {title}
        </h2>
        <button type="button" aria-label="Close" onClick={onClose} style={{ ...iconButtonStyle, background: 'var(--c-surface-raised)' }}>
          <CloseIcon />
        </button>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        style={{ padding: 'var(--sp-4) var(--sp-5) var(--sp-5)' }}
      >
        {content}
        {errorLine}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--sp-2)' }}>
          <button type="button" onClick={onClose} style={textButtonStyle}>Cancel</button>
          <button type="submit" disabled={saving || !ready} style={{ ...primaryButtonStyle, opacity: saving || !ready ? 0.6 : 1 }}>
            {saving ? 'Saving…' : 'Save harvest'}
          </button>
        </div>
      </form>
      {deleteDialog}
    </HarvestModal>
  );
}

function Thumb({ url, onRemove }: { url: string; onRemove: () => void }) {
  return (
    <div style={{ position: 'relative', width: 72, height: 72 }}>
      <img src={url} alt="" style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 'var(--r-md)', display: 'block' }} />
      <button
        type="button"
        aria-label="Remove photo"
        onClick={onRemove}
        style={{
          ...iconButtonStyle,
          position: 'absolute',
          top: -10,
          right: -10,
          background: 'var(--c-surface)',
          boxShadow: 'var(--shadow-md)',
          color: 'var(--c-text)',
        }}
      >
        <CloseIcon width={16} height={16} />
      </button>
    </div>
  );
}

function TierNotice({ text, link, onDismiss }: { text: string; link: { to: string; label: string }; onDismiss: () => void }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 'var(--sp-2)',
        padding: 'var(--sp-2) var(--sp-2) var(--sp-2) var(--sp-3)',
        background: 'var(--c-primary-subtle)',
        borderRadius: 'var(--r-md)',
      }}
    >
      <div style={{ flex: 1, fontSize: 14, color: 'var(--c-text-2)', lineHeight: 1.5, paddingTop: 'var(--sp-2)' }}>
        {text}{' '}
        <Link to={link.to} style={{ ...textLinkButtonStyle, padding: 0, minWidth: 0, verticalAlign: 'middle' }}>
          {link.label}
        </Link>
      </div>
      <button type="button" aria-label="Dismiss" onClick={onDismiss} style={iconButtonStyle}>
        <CloseIcon width={18} height={18} />
      </button>
    </div>
  );
}
