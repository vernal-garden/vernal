// client/src/components/catalogue/SeedForm.tsx
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { get, post, patch } from '../../lib/api';
import { useFamilies } from '../../hooks/useFamilies';
import type { PersonalSeedDetail, CatalogueSeedDetail, FamilyEntry } from '../../types/catalogue';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SeedFormProps {
  mode: 'add' | 'edit';
  initialSeed?: PersonalSeedDetail;
  onClose: () => void;
  onSaved: (seed: PersonalSeedDetail) => void;
}

interface FormState {
  commonName: string;
  plantFamily: string;
  scientificName: string;
  spacingInches: string;
  maturityDaysMin: string;
  maturityDaysMax: string;
  weeksToTransplant: string;
  sunlight: string;
  wateringNeeds: string;
  hardinessZoneMin: string;
  hardinessZoneMax: string;
  frostTolerance: string;
  successionIntervalWeeks: string;
  userNotes: string;
  rowSpacingInches: string;
  plantingDepthInches: string;
  germinationDaysMin: string;
  germinationDaysMax: string;
  germinationTempMinF: string;
  germinationTempMaxF: string;
  tags: string[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toStr(v: number | null | undefined): string {
  return v == null ? '' : String(v);
}

function toF(celsius: number): number {
  return Math.round(celsius * 9 / 5 + 32);
}
function toCelsius(f: number): number {
  return Math.round((f - 32) * 5 / 9);
}
function toIn(cm: number): number {
  return Math.round((cm / 2.54) * 100) / 100;
}

function seedToForm(seed: PersonalSeedDetail): FormState {
  return {
    commonName: seed.commonName,
    plantFamily: seed.plantFamily ?? '',
    scientificName: seed.scientificName ?? '',
    spacingInches: toStr(seed.spacingInches),
    maturityDaysMin: toStr(seed.maturityDaysMin),
    maturityDaysMax: toStr(seed.maturityDaysMax),
    weeksToTransplant: toStr(seed.weeksToTransplant),
    sunlight: seed.sunlight ?? '',
    wateringNeeds: seed.wateringNeeds ?? '',
    hardinessZoneMin: seed.hardinessZoneMin ?? '',
    hardinessZoneMax: seed.hardinessZoneMax ?? '',
    frostTolerance: seed.frostTolerance ?? '',
    successionIntervalWeeks: toStr(seed.successionIntervalWeeks),
    userNotes: seed.userNotes ?? '',
    rowSpacingInches: toStr(seed.rowSpacingInches),
    plantingDepthInches: toStr(seed.plantingDepthInches),
    germinationDaysMin: toStr(seed.germinationDaysMin),
    germinationDaysMax: toStr(seed.germinationDaysMax),
    germinationTempMinF: toStr(seed.germinationTempMinF),
    germinationTempMaxF: toStr(seed.germinationTempMaxF),
    tags: seed.tags ?? [],
  };
}

function emptyForm(): FormState {
  return {
    commonName: '', plantFamily: '', scientificName: '',
    spacingInches: '', maturityDaysMin: '', maturityDaysMax: '',
    weeksToTransplant: '', sunlight: '', wateringNeeds: '',
    hardinessZoneMin: '', hardinessZoneMax: '', frostTolerance: '',
    successionIntervalWeeks: '', userNotes: '',
    rowSpacingInches: '', plantingDepthInches: '',
    germinationDaysMin: '', germinationDaysMax: '',
    germinationTempMinF: '', germinationTempMaxF: '',
    tags: [],
  };
}

// Return the canonical (in/°F) numeric value or null
function parseInches(raw: string, unit: 'in' | 'cm'): number | null {
  const v = parseFloat(raw);
  if (isNaN(v) || v < 0) return null;
  return unit === 'cm' ? toIn(v) : v;
}
function parseTempF(raw: string, unit: 'F' | 'C'): number | null {
  const v = parseFloat(raw);
  if (isNaN(v)) return null;
  return unit === 'C' ? toF(v) : v;
}
function parseInt2(raw: string): number | null {
  const v = parseInt(raw, 10);
  return isNaN(v) || v < 0 ? null : v;
}

// Build validation errors
function validate(f: FormState): string[] {
  const errs: string[] = [];
  if (!f.commonName.trim()) errs.push('Common name is required.');
  if (f.commonName.length > 120) errs.push('Common name must be 120 chars or less.');
  if (!f.plantFamily.trim()) errs.push('Plant family is required.');
  if (f.plantFamily.length > 80) errs.push('Plant family must be 80 chars or less.');
  const matMin = parseInt2(f.maturityDaysMin);
  const matMax = parseInt2(f.maturityDaysMax);
  if (matMin !== null && matMax !== null && matMin > matMax)
    errs.push('Maturity min must be \u2264 max.');
  const gdMin = parseInt2(f.germinationDaysMin);
  const gdMax = parseInt2(f.germinationDaysMax);
  if (gdMin !== null && gdMax !== null && gdMin > gdMax)
    errs.push('Germination days min must be \u2264 max.');
  const gtMin = parseFloat(f.germinationTempMinF);
  const gtMax = parseFloat(f.germinationTempMaxF);
  if (!isNaN(gtMin) && !isNaN(gtMax) && gtMin > gtMax)
    errs.push('Germination temp min must be \u2264 max.');
  if (f.tags.length > 20) errs.push('Max 20 tags.');
  if (f.tags.some(t => t.length > 40)) errs.push('Each tag must be 40 chars or less.');
  return errs;
}

// Build POST payload
function buildAddPayload(f: FormState, spacingUnit: 'in' | 'cm', tempUnit: 'F' | 'C') {
  const payload: Record<string, unknown> = {
    commonName: f.commonName.trim(),
    plantFamily: f.plantFamily.trim(),
  };
  if (f.scientificName.trim()) payload.scientificName = f.scientificName.trim();
  const sp = parseInches(f.spacingInches, spacingUnit);
  if (sp !== null) payload.spacingInches = sp;
  const rsp = parseInches(f.rowSpacingInches, spacingUnit);
  if (rsp !== null) payload.rowSpacingInches = rsp;
  const pd = parseInches(f.plantingDepthInches, spacingUnit);
  if (pd !== null) payload.plantingDepthInches = pd;
  const mmin = parseInt2(f.maturityDaysMin); if (mmin !== null) payload.maturityDaysMin = mmin;
  const mmax = parseInt2(f.maturityDaysMax); if (mmax !== null) payload.maturityDaysMax = mmax;
  const wtt = parseInt2(f.weeksToTransplant); if (wtt !== null) payload.weeksToTransplant = wtt;
  if (f.sunlight) payload.sunlight = f.sunlight;
  if (f.wateringNeeds) payload.wateringNeeds = f.wateringNeeds;
  if (f.hardinessZoneMin.trim()) payload.hardinessZoneMin = f.hardinessZoneMin.trim();
  if (f.hardinessZoneMax.trim()) payload.hardinessZoneMax = f.hardinessZoneMax.trim();
  if (f.frostTolerance) payload.frostTolerance = f.frostTolerance;
  const sw = parseInt2(f.successionIntervalWeeks); if (sw !== null) payload.successionIntervalWeeks = sw;
  if (f.userNotes.trim()) payload.userNotes = f.userNotes.trim();
  const gdmin = parseInt2(f.germinationDaysMin); if (gdmin !== null) payload.germinationDaysMin = gdmin;
  const gdmax = parseInt2(f.germinationDaysMax); if (gdmax !== null) payload.germinationDaysMax = gdmax;
  const gtmin = parseTempF(f.germinationTempMinF, tempUnit); if (gtmin !== null) payload.germinationTempMinF = gtmin;
  const gtmax = parseTempF(f.germinationTempMaxF, tempUnit); if (gtmax !== null) payload.germinationTempMaxF = gtmax;
  if (f.tags.length > 0) payload.tags = f.tags;
  return payload;
}

// Build PATCH payload — only send fields that differ from original
function buildEditPayload(
  f: FormState,
  orig: PersonalSeedDetail,
  spacingUnit: 'in' | 'cm',
  tempUnit: 'F' | 'C',
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

  const cn = f.commonName.trim();
  if (cn !== orig.commonName) payload.commonName = cn;
  const pf = f.plantFamily.trim();
  if (pf !== (orig.plantFamily ?? '')) payload.plantFamily = pf;
  const sn = f.scientificName.trim() || null;
  if (sn !== (orig.scientificName ?? null)) payload.scientificName = sn;

  const sp = parseInches(f.spacingInches, spacingUnit);
  if (sp !== (orig.spacingInches ?? null)) payload.spacingInches = sp;
  const rsp = parseInches(f.rowSpacingInches, spacingUnit);
  if (rsp !== (orig.rowSpacingInches ?? null)) payload.rowSpacingInches = rsp;
  const pd = parseInches(f.plantingDepthInches, spacingUnit);
  if (pd !== (orig.plantingDepthInches ?? null)) payload.plantingDepthInches = pd;

  const mmin = parseInt2(f.maturityDaysMin);
  if (mmin !== (orig.maturityDaysMin ?? null)) payload.maturityDaysMin = mmin;
  const mmax = parseInt2(f.maturityDaysMax);
  if (mmax !== (orig.maturityDaysMax ?? null)) payload.maturityDaysMax = mmax;
  const wtt = parseInt2(f.weeksToTransplant);
  if (wtt !== (orig.weeksToTransplant ?? null)) payload.weeksToTransplant = wtt;

  const sl = f.sunlight || null;
  if (sl !== (orig.sunlight ?? null)) payload.sunlight = sl;
  const wn = f.wateringNeeds || null;
  if (wn !== (orig.wateringNeeds ?? null)) payload.wateringNeeds = wn;
  const ft = f.frostTolerance || null;
  if (ft !== (orig.frostTolerance ?? null)) payload.frostTolerance = ft;

  const hzMin = f.hardinessZoneMin.trim() || null;
  if (hzMin !== (orig.hardinessZoneMin ?? null)) payload.hardinessZoneMin = hzMin;
  const hzMax = f.hardinessZoneMax.trim() || null;
  if (hzMax !== (orig.hardinessZoneMax ?? null)) payload.hardinessZoneMax = hzMax;

  const sw = parseInt2(f.successionIntervalWeeks);
  if (sw !== (orig.successionIntervalWeeks ?? null)) payload.successionIntervalWeeks = sw;

  const un = f.userNotes.trim() || null;
  if (un !== (orig.userNotes ?? null)) payload.userNotes = un;

  const gdmin = parseInt2(f.germinationDaysMin);
  if (gdmin !== (orig.germinationDaysMin ?? null)) payload.germinationDaysMin = gdmin;
  const gdmax = parseInt2(f.germinationDaysMax);
  if (gdmax !== (orig.germinationDaysMax ?? null)) payload.germinationDaysMax = gdmax;
  const gtmin = parseTempF(f.germinationTempMinF, tempUnit);
  if (gtmin !== (orig.germinationTempMinF ?? null)) payload.germinationTempMinF = gtmin;
  const gtmax = parseTempF(f.germinationTempMaxF, tempUnit);
  if (gtmax !== (orig.germinationTempMaxF ?? null)) payload.germinationTempMaxF = gtmax;

  const tagsChanged =
    JSON.stringify(f.tags.slice().sort()) !== JSON.stringify((orig.tags ?? []).slice().sort());
  if (tagsChanged) payload.tags = f.tags;

  return payload;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function FieldLabel({ children, required }: { children: React.ReactNode; required?: boolean }) {
  return (
    <label style={{
      display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--c-text-3)',
      textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 'var(--sp-1)',
      fontFamily: 'var(--font-ui)',
    }}>
      {children}{required && <span style={{ color: 'var(--c-danger)', marginLeft: 3 }}>*</span>}
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box',
  padding: 'var(--sp-2) var(--sp-3)',
  fontFamily: 'var(--font-ui)', fontSize: 14, color: 'var(--c-text)',
  background: 'var(--c-surface-inset)', border: '1px solid var(--c-border)',
  borderRadius: 'var(--r-md)', outline: 'none',
};

const selectStyle: React.CSSProperties = {
  ...inputStyle,
  cursor: 'pointer',
  WebkitAppearance: 'none',
  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%238a7e6f' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E")`,
  backgroundRepeat: 'no-repeat',
  backgroundPosition: 'right 10px center',
  paddingRight: 28,
};

function UnitToggle({ unit, onChange, options }: {
  unit: string;
  onChange: (v: string) => void;
  options: [string, string][];
}) {
  return (
    <div style={{ display: 'flex', borderRadius: 'var(--r-sm)', overflow: 'hidden', border: '1px solid var(--c-border)', flexShrink: 0 }}>
      {options.map(([value, label]) => (
        <button
          key={value}
          type="button"
          onClick={() => onChange(value)}
          style={{
            padding: '4px 10px', fontSize: 12, fontFamily: 'var(--font-ui)',
            border: 'none', cursor: 'pointer', fontWeight: unit === value ? 600 : 400,
            background: unit === value ? 'var(--c-primary)' : 'var(--c-surface)',
            color: unit === value ? 'var(--c-text-on-primary)' : 'var(--c-text-2)',
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function TagInput({ tags, onChange }: { tags: string[]; onChange: (t: string[]) => void }) {
  const [input, setInput] = useState('');

  function addTag() {
    const t = input.trim();
    if (!t || tags.includes(t) || tags.length >= 20 || t.length > 40) { setInput(''); return; }
    onChange([...tags, t]);
    setInput('');
  }

  function removeTag(idx: number) {
    onChange(tags.filter((_, i) => i !== idx));
  }

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--sp-1)', marginBottom: 'var(--sp-2)' }}>
        {tags.map((t, i) => (
          <span key={t} style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            padding: '2px 8px', borderRadius: 'var(--r-full)',
            background: 'var(--c-primary-subtle)', border: '1px solid var(--c-primary-light)',
            fontSize: 12, color: 'var(--c-primary-dark)', fontFamily: 'var(--font-ui)',
          }}>
            {t}
            <button
              type="button"
              onClick={() => removeTag(i)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: 'inherit', fontSize: 14, lineHeight: 1 }}
            >
              &times;
            </button>
          </span>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 'var(--sp-2)' }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } }}
          placeholder="Add tag\u2026"
          style={{ ...inputStyle, flex: 1 }}
          maxLength={40}
        />
        <button
          type="button"
          onClick={addTag}
          disabled={!input.trim() || tags.length >= 20}
          style={{
            padding: '0 14px', background: 'var(--c-surface)', border: '1px solid var(--c-border)',
            borderRadius: 'var(--r-md)', cursor: 'pointer', fontSize: 13, color: 'var(--c-text-2)',
            fontFamily: 'var(--font-ui)',
          }}
        >
          Add
        </button>
      </div>
      <div style={{ fontSize: 11, color: 'var(--c-text-3)', marginTop: 4 }}>{tags.length}/20 tags</div>
    </div>
  );
}

// Family searchable select using datalist
function FamilyInput({ value, onChange, families }: {
  value: string;
  onChange: (v: string) => void;
  families: FamilyEntry[];
}) {
  const id = 'seed-form-family-list';
  return (
    <>
      <input
        list={id}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder="e.g. Solanaceae"
        style={inputStyle}
        maxLength={80}
      />
      <datalist id={id}>
        {families.map(f => (
          <option key={f.family} value={f.family} />
        ))}
      </datalist>
    </>
  );
}

// Cambium suggestion banner
function CambiumBanner({ match, onUse, onDismiss }: {
  match: { id: string; commonName: string; plantFamily: string | null };
  onUse: () => void;
  onDismiss: () => void;
}) {
  return (
    <div style={{
      background: 'var(--c-primary-subtle)', border: '1px solid var(--c-primary-light)',
      borderRadius: 'var(--r-md)', padding: 'var(--sp-3)',
      display: 'flex', alignItems: 'center', gap: 'var(--sp-3)', flexWrap: 'wrap',
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--c-primary-dark)', fontFamily: 'var(--font-ui)' }}>
          Found in Cambium: <em style={{ fontStyle: 'italic' }}>{match.commonName}</em>
        </div>
        {match.plantFamily && (
          <div style={{ fontSize: 12, color: 'var(--c-text-3)', marginTop: 2 }}>{match.plantFamily}</div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 'var(--sp-2)' }}>
        <button
          type="button"
          onClick={onUse}
          style={{
            padding: '5px 12px', fontSize: 12, fontFamily: 'var(--font-ui)', fontWeight: 600,
            background: 'var(--c-primary)', color: 'var(--c-text-on-primary)',
            border: 'none', borderRadius: 'var(--r-sm)', cursor: 'pointer',
          }}
        >
          Use Cambium data
        </button>
        <button
          type="button"
          onClick={onDismiss}
          style={{
            padding: '5px 12px', fontSize: 12, fontFamily: 'var(--font-ui)',
            background: 'transparent', color: 'var(--c-text-2)',
            border: '1px solid var(--c-border)', borderRadius: 'var(--r-sm)', cursor: 'pointer',
          }}
        >
          Keep mine
        </button>
      </div>
    </div>
  );
}

// Discard confirm inline prompt
function DiscardPrompt({ onDiscard, onKeep }: { onDiscard: () => void; onKeep: () => void }) {
  return (
    <div style={{
      background: 'var(--c-surface-raised)', border: '1px solid var(--c-border)',
      borderRadius: 'var(--r-md)', padding: 'var(--sp-3)',
      display: 'flex', alignItems: 'center', gap: 'var(--sp-3)', flexWrap: 'wrap',
    }}>
      <span style={{ flex: 1, fontSize: 14, fontFamily: 'var(--font-ui)', color: 'var(--c-text)' }}>
        Discard unsaved changes?
      </span>
      <div style={{ display: 'flex', gap: 'var(--sp-2)' }}>
        <button
          type="button"
          onClick={onDiscard}
          style={{
            padding: '5px 12px', fontSize: 12, fontFamily: 'var(--font-ui)',
            background: 'var(--c-danger)', color: '#fff', border: 'none',
            borderRadius: 'var(--r-sm)', cursor: 'pointer',
          }}
        >
          Discard
        </button>
        <button
          type="button"
          onClick={onKeep}
          style={{
            padding: '5px 12px', fontSize: 12, fontFamily: 'var(--font-ui)',
            background: 'transparent', color: 'var(--c-text-2)',
            border: '1px solid var(--c-border)', borderRadius: 'var(--r-sm)', cursor: 'pointer',
          }}
        >
          Keep editing
        </button>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function SeedForm({ mode, initialSeed, onClose, onSaved }: SeedFormProps) {
  const { families } = useFamilies();

  const [form, setForm] = useState<FormState>(() =>
    mode === 'edit' && initialSeed ? seedToForm(initialSeed) : emptyForm()
  );
  const [spacingUnit, setSpacingUnit] = useState<'in' | 'cm'>('in');
  const [tempUnit, setTempUnit] = useState<'F' | 'C'>('F');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [showDiscard, setShowDiscard] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);

  // Cambium lookup state
  const [cambiumMatch, setCambiumMatch] = useState<{ id: string; commonName: string; plantFamily: string | null } | null>(null);
  const [cambiumDismissed, setCambiumDismissed] = useState(false);
  const lastLookedUp = useRef('');
  const lookupTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Close button ref for initial focus
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { closeBtnRef.current?.focus(); }, []);

  // Body scroll lock
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  // Debounce timer cleanup on unmount
  useEffect(() => {
    return () => {
      if (lookupTimer.current) clearTimeout(lookupTimer.current);
    };
  }, []);

  const requestClose = useCallback(() => {
    let dirty: boolean;
    if (mode === 'add') {
      dirty = Object.entries(form).some(([k, v]) =>
        k === 'tags' ? (v as string[]).length > 0 : v !== ''
      );
    } else if (initialSeed) {
      dirty = Object.keys(buildEditPayload(form, initialSeed, spacingUnit, tempUnit)).length > 0;
    } else {
      dirty = false;
    }
    if (dirty) { setShowDiscard(true); return; }
    onClose();
  }, [form, initialSeed, spacingUnit, tempUnit, mode, onClose]);

  // Escape key — request close (with dirty check)
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') requestClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [requestClose]);

  function setField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm(prev => ({ ...prev, [key]: value }));
  }

// Cambium lookup on commonName blur
  const handleCommonNameBlur = useCallback(() => {
    const name = form.commonName.trim();
    if (!name || name === lastLookedUp.current || cambiumDismissed) return;
    if (lookupTimer.current) clearTimeout(lookupTimer.current);
    lookupTimer.current = setTimeout(async () => {
      lastLookedUp.current = name;
      try {
        const res = await get<{ data: Array<{ id: string; commonName: string; plantFamily: string | null }> }>(
          `/api/catalogue/seeds?q=${encodeURIComponent(name)}`
        );
        const first = res?.data?.[0];
        if (first && first.commonName.toLowerCase() === name.toLowerCase()) {
          setCambiumMatch(first);
        }
      } catch {
        // silently ignore
      }
    }, 400);
  }, [form.commonName, cambiumDismissed]);

  // Prefill from Cambium detail
  async function handleUseCambium() {
    if (!cambiumMatch) return;
    try {
      const detail = await get<CatalogueSeedDetail>(`/api/catalogue/seeds/${cambiumMatch.id}`);
      if (!detail) return;
      setForm(prev => ({
        ...prev,
        commonName: detail.commonName,
        plantFamily: detail.plantFamily ?? prev.plantFamily,
        scientificName: detail.scientificName ?? prev.scientificName,
        spacingInches: toStr(detail.spacingInches),
        maturityDaysMin: toStr(detail.maturityDaysMin),
        maturityDaysMax: toStr(detail.maturityDaysMax),
        weeksToTransplant: toStr(detail.weeksToTransplant),
        sunlight: detail.sunlight ?? prev.sunlight,
        wateringNeeds: detail.wateringNeeds ?? prev.wateringNeeds,
        hardinessZoneMin: detail.hardinessZoneMin ?? prev.hardinessZoneMin,
        hardinessZoneMax: detail.hardinessZoneMax ?? prev.hardinessZoneMax,
        frostTolerance: detail.frostTolerance ?? prev.frostTolerance,
        successionIntervalWeeks: toStr(detail.successionIntervalWeeks),
        rowSpacingInches: toStr(detail.rowSpacingInches),
        plantingDepthInches: toStr(detail.plantingDepthInches),
        germinationDaysMin: toStr(detail.germinationDaysMin),
        germinationDaysMax: toStr(detail.germinationDaysMax),
        germinationTempMinF: toStr(detail.germinationTempMinF),
        germinationTempMaxF: toStr(detail.germinationTempMaxF),
      }));
    } catch {
      // silently ignore
    } finally {
      setCambiumMatch(null);
      setCambiumDismissed(true);
    }
  }

  async function handleSave() {
    const errs = validate(form);
    if (errs.length > 0) { setValidationErrors(errs); return; }
    setValidationErrors([]);
    setSaveError(null);
    setSaving(true);
    try {
      let saved: PersonalSeedDetail | undefined;
      if (mode === 'add') {
        const payload = buildAddPayload(form, spacingUnit, tempUnit);
        saved = await post<PersonalSeedDetail>('/api/seeds', payload);
      } else {
        if (!initialSeed) return;
        const payload = buildEditPayload(form, initialSeed, spacingUnit, tempUnit);
        if (Object.keys(payload).length === 0) { onClose(); return; }
        saved = await patch<PersonalSeedDetail>(`/api/seeds/${initialSeed.id}`, payload);
      }
      if (saved) onSaved(saved);
    } catch (err: unknown) {
      const body = (err as { body?: { error?: string } })?.body;
      setSaveError(body?.error ?? 'Failed to save. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  const canSave = form.commonName.trim() !== '' && form.plantFamily.trim() !== '';

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 300,
        background: 'rgba(42,35,24,0.55)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        padding: '40px 16px',
        overflowY: 'auto',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) requestClose(); }}
    >
      <div
        style={{
          background: 'var(--c-surface)',
          borderRadius: 'var(--r-xl)',
          boxShadow: 'var(--shadow-lg)',
          width: '100%',
          maxWidth: 640,
          padding: 'var(--sp-6)',
          position: 'relative',
          fontFamily: 'var(--font-ui)',
          animation: 'catalogue-fade-in 0.18s ease',
        }}
        role="dialog"
        aria-modal="true"
        aria-label={mode === 'add' ? 'Add a seed' : `Edit ${initialSeed?.commonName ?? 'seed'}`}
        onClick={e => e.stopPropagation()}
      >
        <style>{`@keyframes catalogue-fade-in { from { opacity: 0 } to { opacity: 1 } }`}</style>

        {/* Close button */}
        <button
          ref={closeBtnRef}
          type="button"
          onClick={requestClose}
          style={{
            position: 'absolute', top: 'var(--sp-4)', right: 'var(--sp-4)',
            background: 'var(--c-surface-raised)', border: 'none',
            borderRadius: 'var(--r-full)', width: 32, height: 32,
            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 18, color: 'var(--c-text-2)',
          }}
          aria-label="Close"
        >
          &#x2715;
        </button>

        {/* Header */}
        <h2 style={{ margin: '0 0 var(--sp-5)', fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 600, color: 'var(--c-text)' }}>
          {mode === 'add' ? 'Add a seed' : `Edit ${initialSeed?.commonName ?? 'seed'}`}
        </h2>

        {/* Discard prompt */}
        {showDiscard && (
          <div style={{ marginBottom: 'var(--sp-4)' }}>
            <DiscardPrompt onDiscard={onClose} onKeep={() => setShowDiscard(false)} />
          </div>
        )}

        {/* Cambium suggestion */}
        {cambiumMatch && !cambiumDismissed && (
          <div style={{ marginBottom: 'var(--sp-4)' }}>
            <CambiumBanner
              match={cambiumMatch}
              onUse={handleUseCambium}
              onDismiss={() => { setCambiumMatch(null); setCambiumDismissed(true); }}
            />
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)' }}>

          {/* Common name */}
          <div>
            <FieldLabel required>Common name</FieldLabel>
            <input
              value={form.commonName}
              onChange={e => setField('commonName', e.target.value)}
              onBlur={handleCommonNameBlur}
              maxLength={120}
              placeholder="e.g. Cherry Tomato"
              style={inputStyle}
            />
          </div>

          {/* Plant family */}
          <div>
            <FieldLabel required>Plant family</FieldLabel>
            <FamilyInput
              value={form.plantFamily}
              onChange={v => setField('plantFamily', v)}
              families={families}
            />
          </div>

          {/* Scientific name */}
          <div>
            <FieldLabel>Scientific name</FieldLabel>
            <input
              value={form.scientificName}
              onChange={e => setField('scientificName', e.target.value)}
              placeholder="e.g. Solanum lycopersicum"
              style={{ ...inputStyle, fontStyle: 'italic' }}
            />
          </div>

          {/* Spacing + unit toggle */}
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--sp-1)' }}>
              <FieldLabel>Spacing</FieldLabel>
              <UnitToggle
                unit={spacingUnit}
                onChange={v => {
                  // Convert displayed values when unit changes
                  const convert = (raw: string) => {
                    const n = parseFloat(raw);
                    if (isNaN(n)) return raw;
                    if (v === 'cm') return String(Math.round(n * 2.54 * 100) / 100);
                    return String(Math.round((n / 2.54) * 100) / 100);
                  };
                  if (v !== spacingUnit) {
                    setForm(prev => ({
                      ...prev,
                      spacingInches: convert(prev.spacingInches),
                      rowSpacingInches: convert(prev.rowSpacingInches),
                      plantingDepthInches: convert(prev.plantingDepthInches),
                    }));
                  }
                  setSpacingUnit(v as 'in' | 'cm');
                }}
                options={[['in', 'in'], ['cm', 'cm']]}
              />
            </div>
            <input
              type="number"
              min={0}
              step={0.1}
              value={form.spacingInches}
              onChange={e => setField('spacingInches', e.target.value)}
              placeholder={spacingUnit === 'in' ? 'inches' : 'cm'}
              style={inputStyle}
            />
          </div>

          {/* Maturity range */}
          <div>
            <FieldLabel>Maturity (days)</FieldLabel>
            <div style={{ display: 'flex', gap: 'var(--sp-2)', alignItems: 'center' }}>
              <input type="number" min={0} value={form.maturityDaysMin} onChange={e => setField('maturityDaysMin', e.target.value)} placeholder="Min" style={{ ...inputStyle, flex: 1 }} />
              <span style={{ color: 'var(--c-text-3)', fontSize: 13 }}>to</span>
              <input type="number" min={0} value={form.maturityDaysMax} onChange={e => setField('maturityDaysMax', e.target.value)} placeholder="Max" style={{ ...inputStyle, flex: 1 }} />
            </div>
          </div>

          {/* Weeks to transplant */}
          <div>
            <FieldLabel>Weeks to transplant</FieldLabel>
            <input type="number" min={0} value={form.weeksToTransplant} onChange={e => setField('weeksToTransplant', e.target.value)} placeholder="e.g. 6" style={inputStyle} />
          </div>

          {/* Sunlight */}
          <div>
            <FieldLabel>Sunlight</FieldLabel>
            <select value={form.sunlight} onChange={e => setField('sunlight', e.target.value)} style={selectStyle}>
              <option value="">&mdash; select &mdash;</option>
              <option value="full_sun">Full sun</option>
              <option value="partial_shade">Partial shade</option>
              <option value="full_shade">Full shade</option>
            </select>
          </div>

          {/* Watering needs */}
          <div>
            <FieldLabel>Watering needs</FieldLabel>
            <select value={form.wateringNeeds} onChange={e => setField('wateringNeeds', e.target.value)} style={selectStyle}>
              <option value="">&mdash; select &mdash;</option>
              <option value="low">Low</option>
              <option value="moderate">Moderate</option>
              <option value="high">High</option>
            </select>
          </div>

          {/* Hardiness zones */}
          <div>
            <FieldLabel>Hardiness zone</FieldLabel>
            <div style={{ display: 'flex', gap: 'var(--sp-2)', alignItems: 'center' }}>
              <input value={form.hardinessZoneMin} onChange={e => setField('hardinessZoneMin', e.target.value)} placeholder="Min (e.g. 4)" style={{ ...inputStyle, flex: 1 }} />
              <span style={{ color: 'var(--c-text-3)', fontSize: 13 }}>to</span>
              <input value={form.hardinessZoneMax} onChange={e => setField('hardinessZoneMax', e.target.value)} placeholder="Max (e.g. 10)" style={{ ...inputStyle, flex: 1 }} />
            </div>
          </div>

          {/* Frost tolerance */}
          <div>
            <FieldLabel>Frost tolerance</FieldLabel>
            <select value={form.frostTolerance} onChange={e => setField('frostTolerance', e.target.value)} style={selectStyle}>
              <option value="">&mdash; select &mdash;</option>
              <option value="none">None</option>
              <option value="light">Light</option>
              <option value="hard">Hard</option>
            </select>
          </div>

          {/* Succession interval */}
          <div>
            <FieldLabel>Succession interval (weeks)</FieldLabel>
            <input type="number" min={0} value={form.successionIntervalWeeks} onChange={e => setField('successionIntervalWeeks', e.target.value)} placeholder="e.g. 2" style={inputStyle} />
          </div>

          {/* Growing notes */}
          <div>
            <FieldLabel>Growing notes</FieldLabel>
            <textarea
              value={form.userNotes}
              onChange={e => setField('userNotes', e.target.value)}
              rows={4}
              placeholder="Notes about this seed\u2026"
              style={{ ...inputStyle, resize: 'vertical' }}
            />
          </div>

          {/* More details disclosure */}
          <div>
            <button
              type="button"
              onClick={() => setAdvancedOpen(o => !o)}
              style={{
                background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                fontFamily: 'var(--font-ui)', fontSize: 13, color: 'var(--c-primary)',
                fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6,
              }}
            >
              <span style={{ fontSize: 11, display: 'inline-block', transform: advancedOpen ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>&#x25B6;</span>
              {advancedOpen ? 'Fewer details' : 'More details'}
            </button>

            {advancedOpen && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)', marginTop: 'var(--sp-4)' }}>

                {/* Row spacing */}
                <div>
                  <FieldLabel>Row spacing ({spacingUnit})</FieldLabel>
                  <input type="number" min={0} step={0.1} value={form.rowSpacingInches} onChange={e => setField('rowSpacingInches', e.target.value)} placeholder={spacingUnit} style={inputStyle} />
                </div>

                {/* Planting depth */}
                <div>
                  <FieldLabel>Planting depth ({spacingUnit})</FieldLabel>
                  <input type="number" min={0} step={0.01} value={form.plantingDepthInches} onChange={e => setField('plantingDepthInches', e.target.value)} placeholder={spacingUnit} style={inputStyle} />
                </div>

                {/* Germination days */}
                <div>
                  <FieldLabel>Germination (days)</FieldLabel>
                  <div style={{ display: 'flex', gap: 'var(--sp-2)', alignItems: 'center' }}>
                    <input type="number" min={0} value={form.germinationDaysMin} onChange={e => setField('germinationDaysMin', e.target.value)} placeholder="Min" style={{ ...inputStyle, flex: 1 }} />
                    <span style={{ color: 'var(--c-text-3)', fontSize: 13 }}>to</span>
                    <input type="number" min={0} value={form.germinationDaysMax} onChange={e => setField('germinationDaysMax', e.target.value)} placeholder="Max" style={{ ...inputStyle, flex: 1 }} />
                  </div>
                </div>

                {/* Germination temp */}
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--sp-1)' }}>
                    <FieldLabel>Germination temp (&deg;{tempUnit})</FieldLabel>
                    <UnitToggle
                      unit={tempUnit}
                      onChange={v => {
                        const conv = (raw: string) => {
                          const n = parseFloat(raw);
                          if (isNaN(n)) return raw;
                          return v === 'C' ? String(toCelsius(n)) : String(toF(n));
                        };
                        if (v !== tempUnit) {
                          setForm(prev => ({
                            ...prev,
                            germinationTempMinF: conv(prev.germinationTempMinF),
                            germinationTempMaxF: conv(prev.germinationTempMaxF),
                          }));
                        }
                        setTempUnit(v as 'F' | 'C');
                      }}
                      options={[['F', '\u00b0F'], ['C', '\u00b0C']]}
                    />
                  </div>
                  <div style={{ display: 'flex', gap: 'var(--sp-2)', alignItems: 'center' }}>
                    <input type="number" value={form.germinationTempMinF} onChange={e => setField('germinationTempMinF', e.target.value)} placeholder="Min" style={{ ...inputStyle, flex: 1 }} />
                    <span style={{ color: 'var(--c-text-3)', fontSize: 13 }}>to</span>
                    <input type="number" value={form.germinationTempMaxF} onChange={e => setField('germinationTempMaxF', e.target.value)} placeholder="Max" style={{ ...inputStyle, flex: 1 }} />
                  </div>
                </div>

                {/* Tags */}
                <div>
                  <FieldLabel>Tags</FieldLabel>
                  <TagInput tags={form.tags} onChange={t => setField('tags', t)} />
                </div>

              </div>
            )}
          </div>

          {/* Validation errors */}
          {validationErrors.length > 0 && (
            <div style={{ padding: 'var(--sp-3)', background: 'rgba(200,40,40,0.07)', border: '1px solid var(--c-danger)', borderRadius: 'var(--r-md)' }}>
              {validationErrors.map((e, i) => (
                <div key={i} style={{ fontSize: 13, color: 'var(--c-danger)', fontFamily: 'var(--font-ui)' }}>{e}</div>
              ))}
            </div>
          )}

          {saveError && (
            <div style={{ fontSize: 13, color: 'var(--c-danger)', fontFamily: 'var(--font-ui)' }}>{saveError}</div>
          )}

          {/* Save / Cancel */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--sp-3)', paddingTop: 'var(--sp-2)', borderTop: '1px solid var(--c-border-subtle)' }}>
            <button
              type="button"
              onClick={requestClose}
              style={{
                padding: '9px 18px', background: 'transparent', color: 'var(--c-text-2)',
                border: '1px solid var(--c-border)', borderRadius: 'var(--r-md)',
                fontFamily: 'var(--font-ui)', fontSize: 14, cursor: 'pointer',
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={!canSave || saving}
              style={{
                padding: '9px 22px', background: 'var(--c-primary)', color: 'var(--c-text-on-primary)',
                border: 'none', borderRadius: 'var(--r-md)',
                fontFamily: 'var(--font-ui)', fontSize: 14, fontWeight: 600,
                cursor: canSave && !saving ? 'pointer' : 'default',
                opacity: canSave && !saving ? 1 : 0.6,
              }}
            >
              {saving ? 'Saving\u2026' : mode === 'add' ? 'Add seed' : 'Save changes'}
            </button>
          </div>

        </div>
      </div>
    </div>
  );
}
