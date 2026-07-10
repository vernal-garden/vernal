import React, { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { get, post, patch } from '../lib/api';
import UpgradePrompt from '../components/UpgradePrompt';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Bed {
  id: string;
  label: string;
}

interface GardenDetail {
  id: string;
  name: string;
  beds: Bed[];
}

interface AmendmentLog {
  id: string;
  gardenId: string;
  bedIds: string[];
  applicationDate: string;
  productName: string;
  amendmentType: string;
  amount: number | null;
  amountUnit: string | null;
  applicationMethod: string | null;
  notes: string | null;
  createdAt: string;
}

interface SoilReading {
  id: string;
  bedId: string;
  testDate: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const AMENDMENT_TYPES = [
  'fertilizer_synthetic', 'fertilizer_organic', 'compost_manure',
  'lime', 'sulphur', 'mulch', 'other',
] as const;

const TYPE_LABELS: Record<string, string> = {
  fertilizer_synthetic: 'Synthetic Fert.',
  fertilizer_organic:   'Organic Fert.',
  compost_manure:       'Compost/Manure',
  lime:                 'Lime',
  sulphur:              'Sulphur',
  mulch:                'Mulch',
  other:                'Other',
};

const TYPE_COLORS: Record<string, { bg: string; color: string }> = {
  fertilizer_synthetic: { bg: '#e3f2fd', color: '#1565c0' },
  fertilizer_organic:   { bg: 'var(--c-success-bg)', color: 'var(--c-success)' },
  compost_manure:       { bg: '#e8f5e9', color: '#2e7d32' },
  lime:                 { bg: '#f3e5f5', color: '#7b1fa2' },
  sulphur:              { bg: '#fff8e1', color: '#f57f17' },
  mulch:                { bg: '#efebe9', color: '#4e342e' },
  other:                { bg: 'var(--c-surface-raised)', color: 'var(--c-text-2)' },
};

const AMOUNT_UNITS = ['oz', 'lbs', 'kg', 'gallons', 'litres', 'cups', 'by hand'];

// ── Helpers ───────────────────────────────────────────────────────────────────

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86_400_000);
}

function filterByDateRange(amendments: AmendmentLog[], range: string): AmendmentLog[] {
  if (range === 'all') return amendments;
  const now = new Date();
  const cutoff = new Date(now);
  if (range === '30')    cutoff.setDate(now.getDate() - 30);
  if (range === '90')    cutoff.setDate(now.getDate() - 90);
  if (range === 'season') cutoff.setMonth(0, 1);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  return amendments.filter(a => a.applicationDate >= cutoffStr);
}

// ── Shared styles ─────────────────────────────────────────────────────────────

const labelSt: React.CSSProperties = {
  display: 'block', fontSize: 11, fontWeight: 600,
  color: 'var(--c-text-3)', textTransform: 'uppercase',
  letterSpacing: '0.06em', marginBottom: 'var(--sp-1)',
  fontFamily: 'var(--font-ui)',
};

const inputSt: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box',
  padding: '8px var(--sp-3)', fontSize: 14,
  fontFamily: 'var(--font-ui)',
  border: '1px solid var(--c-border)', borderRadius: 'var(--r-md)',
  background: 'var(--c-surface)', color: 'var(--c-text)',
  marginBottom: 'var(--sp-3)',
};

const cancelSt: React.CSSProperties = {
  padding: '8px 16px', fontSize: 13, fontFamily: 'var(--font-ui)',
  border: '1px solid var(--c-border)', borderRadius: 'var(--r-md)',
  background: 'transparent', color: 'var(--c-text-2)', cursor: 'pointer',
};

const saveSt: React.CSSProperties = {
  padding: '8px 20px', fontSize: 13, fontFamily: 'var(--font-ui)',
  border: 'none', borderRadius: 'var(--r-md)',
  background: 'var(--c-primary)', color: 'var(--c-text-on-primary)',
  cursor: 'pointer',
};

// ── TypeChip ──────────────────────────────────────────────────────────────────

function TypeChip({ type }: { type: string }) {
  const { bg, color } = TYPE_COLORS[type] ?? TYPE_COLORS['other'];
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px',
      borderRadius: 'var(--r-full)', fontSize: 11,
      fontWeight: 700, fontFamily: 'var(--font-ui)',
      background: bg, color,
    }}>
      {TYPE_LABELS[type] ?? type}
    </span>
  );
}

// ── AmendmentRow ──────────────────────────────────────────────────────────────

function AmendmentRow({
  log,
  beds,
  soilReadings,
  onEdit,
}: {
  log: AmendmentLog;
  beds: Bed[];
  soilReadings: SoilReading[];
  onEdit: (l: AmendmentLog) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [showSoilList, setShowSoilList] = useState(false);

  const bedNames = log.bedIds
    .map(id => beds.find(b => b.id === id)?.label ?? `Bed ${id}`)
    .join(', ');

  // Cross-ref: soil readings for these beds within 30 days AFTER application
  const soilAfter = soilReadings.filter(r => {
    if (!log.bedIds.includes(r.bedId)) return false;
    const days = daysBetween(log.applicationDate, r.testDate);
    return days > 0 && days <= 30;
  });

  return (
    <div
      onClick={() => setExpanded(e => !e)}
      style={{
        padding: 'var(--sp-3)',
        borderBottom: '1px solid var(--c-border-subtle)',
        cursor: 'pointer',
      }}
    >
      {/* Collapsed summary */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: 'var(--c-text-3)', fontFamily: 'var(--font-ui)', minWidth: 90 }}>
          {log.applicationDate}
        </span>
        <TypeChip type={log.amendmentType} />
        <span style={{ flex: 1, fontSize: 14, fontFamily: 'var(--font-ui)', fontWeight: 600, color: 'var(--c-text)', minWidth: 100 }}>
          {log.productName}
        </span>
        {log.amount !== null && (
          <span style={{ fontSize: 12, fontFamily: 'var(--font-ui)', color: 'var(--c-text-3)' }}>
            {log.amount} {log.amountUnit ?? ''}
          </span>
        )}
      </div>
      <div style={{ fontSize: 11, color: 'var(--c-text-3)', fontFamily: 'var(--font-ui)', marginTop: 2 }}>
        {bedNames}
      </div>

      {/* Notes excerpt (collapsed) */}
      {log.notes && !expanded && (
        <p style={{
          margin: '4px 0 0', fontSize: 12, color: 'var(--c-text-3)',
          fontFamily: 'var(--font-ui)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {log.notes.split('\n')[0]}
        </p>
      )}

      {/* Expanded detail */}
      {expanded && (
        <div style={{ marginTop: 'var(--sp-3)' }} onClick={e => e.stopPropagation()}>
          {log.applicationMethod && (
            <p style={{ margin: '0 0 var(--sp-1)', fontSize: 13, color: 'var(--c-text-2)', fontFamily: 'var(--font-ui)' }}>
              Method: {log.applicationMethod}
            </p>
          )}
          {log.notes && (
            <p style={{ margin: '0 0 var(--sp-2)', fontSize: 13, color: 'var(--c-text-2)', fontFamily: 'var(--font-ui)', whiteSpace: 'pre-wrap' }}>
              {log.notes}
            </p>
          )}

          {/* Soil cross-reference */}
          {soilAfter.length > 0 && (
            <div style={{ marginBottom: 'var(--sp-2)' }}>
              <button
                onClick={e => { e.stopPropagation(); setShowSoilList(s => !s); }}
                style={{
                  background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                  fontSize: 12, fontFamily: 'var(--font-ui)',
                  color: 'var(--c-primary)', textDecoration: 'underline',
                }}
              >
                Soil test taken {soilAfter.length === 1 ? daysBetween(log.applicationDate, soilAfter[0].testDate) + ' day' : soilAfter.length + ' tests'} later
              </button>
              {showSoilList && (
                <ul style={{ margin: 'var(--sp-1) 0 0 var(--sp-4)', padding: 0, listStyle: 'disc', fontSize: 12, fontFamily: 'var(--font-ui)', color: 'var(--c-text-2)' }}>
                  {soilAfter.map(r => (
                    <li key={r.id}>
                      {r.testDate} — {daysBetween(log.applicationDate, r.testDate)} day{daysBetween(log.applicationDate, r.testDate) !== 1 ? 's' : ''} later ({beds.find(b => b.id === r.bedId)?.label ?? `Bed ${r.bedId}`})
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <button
            onClick={e => { e.stopPropagation(); onEdit(log); }}
            style={{ ...cancelSt, fontSize: 12, padding: '4px 12px' }}
          >
            Edit
          </button>
        </div>
      )}
    </div>
  );
}

// ── FilterBar ─────────────────────────────────────────────────────────────────

interface FilterBarProps {
  beds: Bed[];
  filterBedId: string;
  filterType: string;
  filterDateRange: string;
  onBedChange: (v: string) => void;
  onTypeChange: (v: string) => void;
  onDateChange: (v: string) => void;
}

function FilterBar({
  beds, filterBedId, filterType, filterDateRange,
  onBedChange, onTypeChange, onDateChange,
}: FilterBarProps) {
  const selSt: React.CSSProperties = {
    padding: '6px 10px', fontSize: 13, fontFamily: 'var(--font-ui)',
    border: '1px solid var(--c-border)', borderRadius: 'var(--r-md)',
    background: 'var(--c-surface)', color: 'var(--c-text)', cursor: 'pointer',
  };

  return (
    <div style={{
      display: 'flex', gap: 'var(--sp-2)', flexWrap: 'wrap',
      marginBottom: 'var(--sp-4)',
      padding: 'var(--sp-3)',
      background: 'var(--c-surface-raised)',
      borderRadius: 'var(--r-md)',
    }}>
      <select value={filterBedId} onChange={e => onBedChange(e.target.value)} style={selSt}>
        <option value="all">All beds</option>
        {beds.map(b => (
          <option key={b.id} value={b.id}>{b.label || `Bed ${b.id}`}</option>
        ))}
      </select>

      <select value={filterType} onChange={e => onTypeChange(e.target.value)} style={selSt}>
        <option value="all">All types</option>
        {AMENDMENT_TYPES.map(t => (
          <option key={t} value={t}>{TYPE_LABELS[t]}</option>
        ))}
      </select>

      <select value={filterDateRange} onChange={e => onDateChange(e.target.value)} style={selSt}>
        <option value="30">Last 30 days</option>
        <option value="90">Last 90 days</option>
        <option value="season">This season</option>
        <option value="all">All time</option>
      </select>
    </div>
  );
}

// ── AmendmentForm ─────────────────────────────────────────────────────────────

interface FormValues {
  bedIds: string[];
  applicationDate: string;
  productName: string;
  amendmentType: string;
  amount: string;
  amountUnit: string;
  applicationMethod: string;
  notes: string;
}

interface AmendmentFormProps {
  beds: Bed[];
  defaultBedIds: string[];
  gardenId: string;
  initial?: FormValues & { id: string };
  onSaved: () => void;
  onCancel: () => void;
}

function AmendmentForm({ beds, defaultBedIds, gardenId, initial, onSaved, onCancel }: AmendmentFormProps) {
  const isEdit = Boolean(initial?.id);
  const [form, setForm] = useState<FormValues>({
    bedIds:            initial?.bedIds            ?? defaultBedIds,
    applicationDate:   initial?.applicationDate   ?? todayISO(),
    productName:       initial?.productName       ?? '',
    amendmentType:     initial?.amendmentType     ?? '',
    amount:            initial?.amount            ?? '',
    amountUnit:        initial?.amountUnit        ?? 'lbs',
    applicationMethod: initial?.applicationMethod ?? '',
    notes:             initial?.notes             ?? '',
  });
  const [error,  setError]  = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const isWide = window.matchMedia('(min-width: 1024px)').matches;
  const byHand = form.amountUnit === 'by hand';

  function toggleBed(bedId: string) {
    setForm(f => ({
      ...f,
      bedIds: f.bedIds.includes(bedId)
        ? f.bedIds.filter(id => id !== bedId)
        : [...f.bedIds, bedId],
    }));
  }

  function selectAllBeds() {
    setForm(f => ({ ...f, bedIds: beds.map(b => b.id) }));
  }

  async function handleSave() {
    if (form.bedIds.length === 0) { setError('Select at least one bed'); return; }
    if (!form.productName.trim())  { setError('Product name is required'); return; }
    if (!form.amendmentType)       { setError('Amendment type is required'); return; }

    setSaving(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = {
        bedIds:            form.bedIds,
        applicationDate:   form.applicationDate,
        productName:       form.productName.trim(),
        amendmentType:     form.amendmentType,
        amountUnit:        form.amountUnit || null,
        applicationMethod: form.applicationMethod || null,
        notes:             form.notes || null,
        amount:            (!byHand && form.amount) ? parseFloat(form.amount) : null,
      };

      if (isEdit) {
        await patch(`/api/amendments/${initial!.id}`, payload);
      } else {
        await post(`/api/gardens/${gardenId}/amendments`, payload);
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  const overlay: React.CSSProperties = {
    position: 'fixed', inset: 0, zIndex: 300,
    background: 'rgba(42,35,24,0.55)',
    display: 'flex',
    alignItems:     isWide ? 'center'   : 'flex-end',
    justifyContent: isWide ? 'center'   : 'stretch',
  };

  const panel: React.CSSProperties = isWide
    ? { background: 'var(--c-surface)', borderRadius: 'var(--r-xl)', boxShadow: 'var(--shadow-lg)', width: '100%', maxWidth: 500, padding: 'var(--sp-6)', maxHeight: '90vh', overflowY: 'auto' }
    : { background: 'var(--c-surface)', borderRadius: 'var(--r-xl) var(--r-xl) 0 0', boxShadow: 'var(--shadow-lg)', width: '100%', padding: 'var(--sp-5) var(--sp-5) var(--sp-7)', maxHeight: '90vh', overflowY: 'auto' };

  return (
    <div style={overlay} onClick={e => { if (e.target === e.currentTarget) onCancel(); }}>
      <div style={panel}>
        <h3 style={{ margin: '0 0 var(--sp-4)', fontFamily: 'var(--font-display)', fontSize: 18, color: 'var(--c-text)' }}>
          {isEdit ? 'Edit amendment' : 'Log amendment'}
        </h3>

        {/* Bed multi-select */}
        <label style={labelSt}>
          Beds <span style={{ color: 'var(--c-danger)' }}>*</span>
        </label>
        <div style={{ marginBottom: 'var(--sp-3)' }}>
          <button
            type="button"
            onClick={selectAllBeds}
            style={{ ...cancelSt, fontSize: 12, padding: '3px 10px', marginBottom: 'var(--sp-2)' }}
          >
            All beds
          </button>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--sp-2)', marginTop: 'var(--sp-1)' }}>
            {beds.map(b => {
              const checked = form.bedIds.includes(b.id);
              return (
                <label
                  key={b.id}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    padding: '4px 10px', borderRadius: 'var(--r-md)',
                    border: `1px solid ${checked ? 'var(--c-primary)' : 'var(--c-border)'}`,
                    background: checked ? 'var(--c-primary-subtle)' : 'transparent',
                    cursor: 'pointer', fontSize: 13, fontFamily: 'var(--font-ui)',
                    color: checked ? 'var(--c-primary)' : 'var(--c-text-2)',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleBed(b.id)}
                    style={{ margin: 0 }}
                  />
                  {b.label || `Bed ${b.id}`}
                </label>
              );
            })}
          </div>
        </div>

        <label style={labelSt}>Application date</label>
        <input
          type="date"
          value={form.applicationDate}
          onChange={e => setForm(f => ({ ...f, applicationDate: e.target.value }))}
          style={inputSt}
        />

        <label style={labelSt}>
          Product name <span style={{ color: 'var(--c-danger)' }}>*</span>
        </label>
        <input
          type="text"
          placeholder="e.g. Garden Tone 3-4-4"
          value={form.productName}
          onChange={e => setForm(f => ({ ...f, productName: e.target.value }))}
          style={inputSt}
        />

        <label style={labelSt}>
          Amendment type <span style={{ color: 'var(--c-danger)' }}>*</span>
        </label>
        <select
          value={form.amendmentType}
          onChange={e => setForm(f => ({ ...f, amendmentType: e.target.value }))}
          style={inputSt}
        >
          <option value="">Select type…</option>
          {AMENDMENT_TYPES.map(t => (
            <option key={t} value={t}>{TYPE_LABELS[t]}</option>
          ))}
        </select>

        {/* Amount + unit */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--sp-2)', marginBottom: 'var(--sp-3)' }}>
          <div>
            <label style={labelSt}>Amount</label>
            <input
              type="number" min="0" step="any"
              placeholder={byHand ? '—' : 'e.g. 2.5'}
              disabled={byHand}
              value={form.amount}
              onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
              style={{ ...inputSt, marginBottom: 0, opacity: byHand ? 0.4 : 1 }}
            />
          </div>
          <div>
            <label style={labelSt}>Unit</label>
            <select
              value={form.amountUnit}
              onChange={e => setForm(f => ({ ...f, amountUnit: e.target.value, amount: e.target.value === 'by hand' ? '' : f.amount }))}
              style={{ ...inputSt, marginBottom: 0 }}
            >
              {AMOUNT_UNITS.map(u => <option key={u} value={u}>{u}</option>)}
            </select>
          </div>
        </div>

        <label style={labelSt}>Application method</label>
        <input
          type="text"
          placeholder="e.g. Side-dress, broadcast, foliar spray"
          value={form.applicationMethod}
          onChange={e => setForm(f => ({ ...f, applicationMethod: e.target.value }))}
          style={inputSt}
        />

        <label style={labelSt}>Notes</label>
        <textarea
          rows={2}
          value={form.notes}
          onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
          style={{ ...inputSt, resize: 'vertical' }}
        />

        {error && (
          <p style={{ color: 'var(--c-danger)', fontSize: 13, fontFamily: 'var(--font-ui)', margin: '0 0 var(--sp-3)' }}>
            {error}
          </p>
        )}

        <div style={{ display: 'flex', gap: 'var(--sp-2)', justifyContent: 'flex-end' }}>
          <button onClick={onCancel} style={cancelSt}>Cancel</button>
          <button onClick={handleSave} disabled={saving} style={saveSt}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Form state ────────────────────────────────────────────────────────────────

type FormState =
  | { open: false }
  | { open: true; mode: 'add' }
  | { open: true; mode: 'edit'; log: AmendmentLog };

// ── AmendmentPage ─────────────────────────────────────────────────────────────

export default function AmendmentPage() {
  const { gardenId } = useParams<{ gardenId: string }>();
  const { account }  = useAuth();

  const [garden,       setGarden]       = useState<GardenDetail | null>(null);
  const [amendments,   setAmendments]   = useState<AmendmentLog[]>([]);
  const [soilReadings, setSoilReadings] = useState<SoilReading[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [form,         setForm]         = useState<FormState>({ open: false });

  // Filter state (session-persisted in component state)
  const [filterBedId,    setFilterBedId]    = useState<string>('all');
  const [filterType,     setFilterType]     = useState<string>('all');
  const [filterDateRange, setFilterDateRange] = useState<string>('all');
  const [showAll,        setShowAll]        = useState(false);

  const isSupporter = account?.subscriptionTier === 'supporter';

  const load = useCallback(async () => {
    if (!gardenId) return;
    setLoading(true);
    try {
      const [g, a, s] = await Promise.all([
        get<GardenDetail>(`/api/gardens/${gardenId}`),
        get<{ data: AmendmentLog[] }>(`/api/gardens/${gardenId}/amendments`),
        get<{ data: SoilReading[] }>(`/api/gardens/${gardenId}/soil-readings`).catch(() => ({ data: [] as SoilReading[] })),
      ]);
      setGarden(g ?? null);
      setAmendments(a?.data ?? []);
      setSoilReadings(s?.data ?? []);
    } finally {
      setLoading(false);
    }
  }, [gardenId]);

  useEffect(() => { load(); }, [load]);

  if (!isSupporter) {
    return (
      <div style={{ padding: 'var(--sp-6)' }}>
        <UpgradePrompt gateKey="amendments" />
      </div>
    );
  }

  if (loading) {
    return (
      <div style={{ padding: 'var(--sp-6)', fontFamily: 'var(--font-ui)', color: 'var(--c-text-3)' }}>
        Loading…
      </div>
    );
  }

  const beds = garden?.beds ?? [];

  // Apply filters
  let filtered = amendments;
  if (filterBedId !== 'all') {
    filtered = filtered.filter(a => a.bedIds.includes(filterBedId));
  }
  if (filterType !== 'all') {
    filtered = filtered.filter(a => a.amendmentType === filterType);
  }
  filtered = filterByDateRange(filtered, filterDateRange);

  const displayed = showAll ? filtered : filtered.slice(0, 10);

  // Default bedIds for new amendment: last used, else all beds
  const defaultBedIds = amendments[0]?.bedIds ?? beds.map(b => b.id);

  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: 'var(--sp-5)' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--sp-4)' }}>
        <h1 style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 24, color: 'var(--c-text)' }}>
          Amendment Log
        </h1>
        <button
          onClick={() => setForm({ open: true, mode: 'add' })}
          style={saveSt}
        >
          + Log amendment
        </button>
      </div>

      {/* Filter bar */}
      <FilterBar
        beds={beds}
        filterBedId={filterBedId}
        filterType={filterType}
        filterDateRange={filterDateRange}
        onBedChange={v => { setFilterBedId(v); setShowAll(false); }}
        onTypeChange={v => { setFilterType(v); setShowAll(false); }}
        onDateChange={v => { setFilterDateRange(v); setShowAll(false); }}
      />

      {/* Timeline */}
      {filtered.length === 0 ? (
        <p style={{ fontFamily: 'var(--font-ui)', fontSize: 14, color: 'var(--c-text-3)' }}>
          No amendments logged yet. Use "+ Log amendment" to get started.
        </p>
      ) : (
        <>
          <div style={{ borderRadius: 'var(--r-lg)', overflow: 'hidden', border: '1px solid var(--c-border)' }}>
            {displayed.map(log => (
              <AmendmentRow
                key={log.id}
                log={log}
                beds={beds}
                soilReadings={soilReadings}
                onEdit={l => setForm({ open: true, mode: 'edit', log: l })}
              />
            ))}
          </div>

          {!showAll && filtered.length > 10 && (
            <button
              onClick={() => setShowAll(true)}
              style={{
                ...cancelSt,
                marginTop: 'var(--sp-3)',
                width: '100%',
                textAlign: 'center',
              }}
            >
              View all ({filtered.length} amendments)
            </button>
          )}
        </>
      )}

      {/* Entry / edit form */}
      {form.open && (
        <AmendmentForm
          beds={beds}
          defaultBedIds={defaultBedIds}
          gardenId={gardenId!}
          initial={
            form.mode === 'edit'
              ? {
                  id:                form.log.id,
                  bedIds:            form.log.bedIds,
                  applicationDate:   form.log.applicationDate,
                  productName:       form.log.productName,
                  amendmentType:     form.log.amendmentType,
                  amount:            form.log.amount?.toString() ?? '',
                  amountUnit:        form.log.amountUnit ?? 'lbs',
                  applicationMethod: form.log.applicationMethod ?? '',
                  notes:             form.log.notes ?? '',
                }
              : undefined
          }
          onSaved={() => { setForm({ open: false }); load(); }}
          onCancel={() => setForm({ open: false })}
        />
      )}
    </div>
  );
}
