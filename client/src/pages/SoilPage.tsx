import React, { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { get, post, patch } from '../lib/api';
import UpgradePrompt from '../components/UpgradePrompt';

// ── Types ─────────────────────────────────────────────────────────────────────

interface AmendmentLog {
  id: string;
  bedIds: string[];
  applicationDate: string;
  productName: string;
  amendmentType: string;
}

interface Bed {
  id: string;
  label: string;
}

interface GardenDetail {
  id: string;
  name: string;
  beds: Bed[];
}

interface SoilReading {
  id: string;
  gardenId: string;
  bedId: string;
  testDate: string;
  ph: number | null;
  nitrogen: number | null;
  phosphorus: number | null;
  potassium: number | null;
  notes: string | null;
  createdAt: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function phColors(ph: number | null): { bg: string; color: string } {
  if (ph === null) return { bg: 'var(--c-surface-raised)', color: 'var(--c-text-3)' };
  if (ph >= 6.0 && ph <= 7.0) return { bg: 'var(--c-success-bg)', color: 'var(--c-success)' };
  return { bg: 'var(--c-warning-bg)', color: 'var(--c-warning)' };
}

function daysSince(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
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

// ── PhBadge ───────────────────────────────────────────────────────────────────

function PhBadge({ ph }: { ph: number | null }) {
  const { bg, color } = phColors(ph);
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px',
      borderRadius: 'var(--r-full)', fontSize: 12,
      fontWeight: 700, fontFamily: 'var(--font-ui)',
      background: bg, color,
    }}>
      {ph !== null ? `pH ${ph.toFixed(1)}` : 'No pH'}
    </span>
  );
}

// ── PhSparkline ───────────────────────────────────────────────────────────────

function PhSparkline({ readings }: { readings: SoilReading[] }) {
  // readings are newest-first; take last 6, reverse to chronological
  const pts = readings.slice(0, 6).reverse().filter(r => r.ph !== null);
  if (pts.length < 3) return null;

  const W = 120, H = 40, PAD = 4;
  const phVals = pts.map(r => r.ph as number);
  const minPh  = Math.min(...phVals);
  const maxPh  = Math.max(...phVals);
  const range  = maxPh - minPh || 1;
  const cx     = (i: number) => PAD + (i / (pts.length - 1)) * (W - PAD * 2);
  const cy     = (v: number) => H - PAD - ((v - minPh) / range) * (H - PAD * 2);
  const d      = pts.map((r, i) =>
    `${i === 0 ? 'M' : 'L'} ${cx(i).toFixed(1)} ${cy(r.ph as number).toFixed(1)}`
  ).join(' ');

  const diff  = phVals[phVals.length - 1] - phVals[0];
  const trend = diff > 0.3 ? 'up' : diff < -0.3 ? 'down' : 'stable';
  const label = trend === 'up' ? '↑ Rising' : trend === 'down' ? '↓ Falling' : '→ Stable';
  const col   = trend === 'stable' ? 'var(--c-text-3)'
              : trend === 'up'     ? 'var(--c-warning)'
              :                      'var(--c-info)';

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 'var(--sp-3)',
      padding: 'var(--sp-3)', background: 'var(--c-surface-raised)',
      borderRadius: 'var(--r-md)', marginBottom: 'var(--sp-3)',
    }}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ display: 'block' }}>
        <path d={d} fill="none" stroke="var(--c-primary)" strokeWidth="1.5" strokeLinejoin="round" />
        {pts.map((r, i) => (
          <circle key={i} cx={cx(i)} cy={cy(r.ph as number)} r="2.5" fill="var(--c-primary)" />
        ))}
      </svg>
      <span style={{ fontSize: 12, fontFamily: 'var(--font-ui)', fontWeight: 600, color: col }}>
        {label}
      </span>
    </div>
  );
}

// ── ReadingRow (timeline item) ────────────────────────────────────────────────

function ReadingRow({
  reading,
  amendments,
  onEdit,
}: {
  reading: SoilReading;
  amendments: AmendmentLog[];
  onEdit: (r: SoilReading) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [showAmendmentList, setShowAmendmentList] = useState(false);

  // Amendments for this bed within 30 days BEFORE the test date
  const testDate = new Date(reading.testDate);
  const thirtyBefore = new Date(testDate);
  thirtyBefore.setDate(thirtyBefore.getDate() - 30);
  const priorAmendments = amendments.filter(a => {
    const appDate = new Date(a.applicationDate);
    return appDate >= thirtyBefore && appDate < testDate;
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, color: 'var(--c-text-2)', fontFamily: 'var(--font-ui)', flex: 1 }}>
          {reading.testDate}
        </span>
        <PhBadge ph={reading.ph} />
        {reading.nitrogen   !== null && <span style={{ fontSize: 11, fontFamily: 'var(--font-ui)', color: 'var(--c-text-3)' }}>N:{reading.nitrogen}</span>}
        {reading.phosphorus !== null && <span style={{ fontSize: 11, fontFamily: 'var(--font-ui)', color: 'var(--c-text-3)' }}>P:{reading.phosphorus}</span>}
        {reading.potassium  !== null && <span style={{ fontSize: 11, fontFamily: 'var(--font-ui)', color: 'var(--c-text-3)' }}>K:{reading.potassium}</span>}
      </div>

      {reading.notes && !expanded && (
        <p style={{
          margin: '4px 0 0', fontSize: 12, color: 'var(--c-text-3)',
          fontFamily: 'var(--font-ui)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {reading.notes.split('\n')[0]}
        </p>
      )}

      {expanded && (
        <div style={{ marginTop: 'var(--sp-2)' }}>
          {reading.notes && (
            <p style={{ margin: '0 0 var(--sp-2)', fontSize: 13, color: 'var(--c-text-2)', fontFamily: 'var(--font-ui)', whiteSpace: 'pre-wrap' }}>
              {reading.notes}
            </p>
          )}

          {priorAmendments.length > 0 && (
            <div style={{ marginBottom: 'var(--sp-2)' }}>
              <button
                onClick={e => { e.stopPropagation(); setShowAmendmentList(s => !s); }}
                style={{
                  background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                  fontSize: 12, fontFamily: 'var(--font-ui)',
                  color: 'var(--c-primary)', textDecoration: 'underline',
                }}
              >
                {priorAmendments.length} amendment{priorAmendments.length !== 1 ? 's' : ''} in the 30 days prior
              </button>
              {showAmendmentList && (
                <ul style={{ margin: 'var(--sp-1) 0 0 var(--sp-4)', padding: 0, listStyle: 'disc', fontSize: 12, fontFamily: 'var(--font-ui)', color: 'var(--c-text-2)' }}>
                  {priorAmendments.map(a => (
                    <li key={a.id}>{a.applicationDate}: {a.productName} ({a.amendmentType.replace(/_/g, ' ')})</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <button
            onClick={(e) => { e.stopPropagation(); onEdit(reading); }}
            style={{ ...cancelSt, fontSize: 12, padding: '4px 12px' }}
          >
            Edit
          </button>
        </div>
      )}
    </div>
  );
}

// ── AllBedsView ───────────────────────────────────────────────────────────────

function AllBedsView({
  beds,
  byBedId,
  onSelect,
}: {
  beds: Bed[];
  byBedId: Record<string, SoilReading[]>;
  onSelect: (id: string) => void;
}) {
  if (beds.length === 0) {
    return (
      <p style={{ fontFamily: 'var(--font-ui)', fontSize: 14, color: 'var(--c-text-3)' }}>
        No beds found. Add beds to your garden canvas first.
      </p>
    );
  }

  return (
    <div style={{ borderRadius: 'var(--r-lg)', overflow: 'hidden', border: '1px solid var(--c-border)' }}>
      {beds.map(bed => {
        const readings = byBedId[bed.id] ?? [];
        const latest   = readings[0] ?? null;
        const stale    = latest && daysSince(latest.testDate) > 90;

        return (
          <div
            key={bed.id}
            onClick={() => onSelect(bed.id)}
            style={{
              display: 'flex', alignItems: 'center', gap: 'var(--sp-3)',
              padding: 'var(--sp-3) var(--sp-4)', cursor: 'pointer',
              borderBottom: '1px solid var(--c-border-subtle)',
              background: 'var(--c-surface)',
            }}
          >
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: 'var(--font-ui)', fontSize: 14, fontWeight: 600, color: 'var(--c-text)' }}>
                {bed.label || `Bed ${bed.id}`}
              </div>
              {!latest && (
                <div style={{ fontSize: 11, color: 'var(--c-text-3)', fontFamily: 'var(--font-ui)' }}>
                  No readings yet
                </div>
              )}
              {latest && stale && (
                <div style={{ fontSize: 11, color: 'var(--c-warning)', fontFamily: 'var(--font-ui)' }}>
                  Test recommended
                </div>
              )}
              {latest && !stale && (
                <div style={{ fontSize: 11, color: 'var(--c-text-3)', fontFamily: 'var(--font-ui)' }}>
                  {latest.testDate}
                </div>
              )}
            </div>
            {latest && <PhBadge ph={latest.ph} />}
          </div>
        );
      })}
    </div>
  );
}

// ── PerBedView ────────────────────────────────────────────────────────────────

function PerBedView({
  bed,
  readings,
  amendments,
  onBack,
  onEdit,
}: {
  bed: Bed;
  readings: SoilReading[];
  amendments: AmendmentLog[];
  onBack: () => void;
  onEdit: (r: SoilReading) => void;
}) {
  // Amendments for this specific bed
  const bedAmendments = amendments.filter(a => a.bedIds.includes(bed.id));

  return (
    <div>
      <button onClick={onBack} style={{ ...cancelSt, fontSize: 12, marginBottom: 'var(--sp-4)' }}>
        ← All beds
      </button>
      <h2 style={{ margin: '0 0 var(--sp-3)', fontFamily: 'var(--font-display)', fontSize: 20, color: 'var(--c-text)' }}>
        {bed.label || `Bed ${bed.id}`}
      </h2>

      <PhSparkline readings={readings} />

      <div style={{ borderRadius: 'var(--r-lg)', overflow: 'hidden', border: '1px solid var(--c-border)' }}>
        {readings.length === 0 ? (
          <p style={{ padding: 'var(--sp-4)', fontFamily: 'var(--font-ui)', fontSize: 14, color: 'var(--c-text-3)', margin: 0 }}>
            No readings yet.
          </p>
        ) : (
          readings.map(r => <ReadingRow key={r.id} reading={r} amendments={bedAmendments} onEdit={onEdit} />)
        )}
      </div>
    </div>
  );
}

// ── EntryForm (modal / bottom-sheet) ─────────────────────────────────────────

interface FormValues {
  bedId: string;
  testDate: string;
  ph: string;
  nitrogen: string;
  phosphorus: string;
  potassium: string;
  notes: string;
}

interface EntryFormProps {
  beds: Bed[];
  defaultBedId: string;
  gardenId: string;
  initial?: FormValues & { id: string };
  onSaved: () => void;
  onCancel: () => void;
}

function EntryForm({ beds, defaultBedId, gardenId, initial, onSaved, onCancel }: EntryFormProps) {
  const isEdit = Boolean(initial?.id);
  const [form, setForm] = useState<FormValues>({
    bedId:      initial?.bedId      ?? defaultBedId,
    testDate:   initial?.testDate   ?? todayISO(),
    ph:         initial?.ph         ?? '',
    nitrogen:   initial?.nitrogen   ?? '',
    phosphorus: initial?.phosphorus ?? '',
    potassium:  initial?.potassium  ?? '',
    notes:      initial?.notes      ?? '',
  });
  const [error,  setError]  = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const isWide = window.matchMedia('(min-width: 1024px)').matches;

  async function handleSave() {
    const phVal = parseFloat(form.ph);
    if (!form.ph || isNaN(phVal) || phVal < 0 || phVal > 14) {
      setError('pH is required and must be between 0 and 14');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = {
        bedId:    form.bedId,
        testDate: form.testDate,
        ph:       phVal,
      };
      if (form.nitrogen)   payload['nitrogen']   = parseInt(form.nitrogen,   10);
      if (form.phosphorus) payload['phosphorus'] = parseInt(form.phosphorus, 10);
      if (form.potassium)  payload['potassium']  = parseInt(form.potassium,  10);
      payload['notes'] = form.notes || null;

      if (isEdit) {
        await patch(`/api/soil-readings/${initial!.id}`, payload);
      } else {
        await post(`/api/gardens/${gardenId}/soil-readings`, payload);
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
    alignItems:     isWide ? 'center'    : 'flex-end',
    justifyContent: isWide ? 'center'    : 'stretch',
  };

  const panel: React.CSSProperties = isWide
    ? { background: 'var(--c-surface)', borderRadius: 'var(--r-xl)', boxShadow: 'var(--shadow-lg)', width: '100%', maxWidth: 460, padding: 'var(--sp-6)' }
    : { background: 'var(--c-surface)', borderRadius: 'var(--r-xl) var(--r-xl) 0 0', boxShadow: 'var(--shadow-lg)', width: '100%', padding: 'var(--sp-5) var(--sp-5) var(--sp-7)' };

  return (
    <div style={overlay} onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div style={panel}>
        <h3 style={{ margin: '0 0 var(--sp-4)', fontFamily: 'var(--font-display)', fontSize: 18, color: 'var(--c-text)' }}>
          {isEdit ? 'Edit reading' : 'Log soil reading'}
        </h3>

        <label style={labelSt}>Bed</label>
        <select
          value={form.bedId}
          onChange={(e) => setForm(f => ({ ...f, bedId: e.target.value }))}
          style={inputSt}
        >
          {beds.map(b => (
            <option key={b.id} value={b.id}>{b.label || `Bed ${b.id}`}</option>
          ))}
        </select>

        <label style={labelSt}>Test date</label>
        <input
          type="date"
          value={form.testDate}
          onChange={(e) => setForm(f => ({ ...f, testDate: e.target.value }))}
          style={inputSt}
        />

        <label style={labelSt}>
          pH <span style={{ color: 'var(--c-danger)' }}>*</span>
        </label>
        <input
          type="number" step="0.1" min="0" max="14"
          placeholder="e.g. 6.5"
          value={form.ph}
          onChange={(e) => setForm(f => ({ ...f, ph: e.target.value }))}
          style={inputSt}
        />

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 'var(--sp-2)', marginBottom: 'var(--sp-3)' }}>
          {(['nitrogen', 'phosphorus', 'potassium'] as const).map((key, idx) => (
            <div key={key}>
              <label style={labelSt}>{['N (ppm)', 'P (ppm)', 'K (ppm)'][idx]}</label>
              <input
                type="number" min="0" placeholder="opt."
                value={form[key]}
                onChange={(e) => setForm(f => ({ ...f, [key]: e.target.value }))}
                style={{ ...inputSt, marginBottom: 0 }}
              />
            </div>
          ))}
        </div>

        <label style={labelSt}>Notes</label>
        <textarea
          rows={2}
          value={form.notes}
          onChange={(e) => setForm(f => ({ ...f, notes: e.target.value }))}
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

// ── View / Form state types ───────────────────────────────────────────────────

type ViewState =
  | { kind: 'all-beds' }
  | { kind: 'per-bed'; bedId: string };

type FormState =
  | { open: false }
  | { open: true; mode: 'add' }
  | { open: true; mode: 'edit'; reading: SoilReading };

// ── SoilPage ──────────────────────────────────────────────────────────────────

export default function SoilPage() {
  const { gardenId } = useParams<{ gardenId: string }>();
  const { account }  = useAuth();

  const [garden,     setGarden]     = useState<GardenDetail | null>(null);
  const [readings,   setReadings]   = useState<SoilReading[]>([]);
  const [amendments, setAmendments] = useState<AmendmentLog[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [view,       setView]       = useState<ViewState>({ kind: 'all-beds' });
  const [form,       setForm]       = useState<FormState>({ open: false });

  const isSupporter = account?.subscriptionTier === 'supporter';

  const load = useCallback(async () => {
    if (!gardenId) return;
    setLoading(true);
    try {
      const [g, r, a] = await Promise.all([
        get<GardenDetail>(`/api/gardens/${gardenId}`),
        get<{ data: SoilReading[] }>(`/api/gardens/${gardenId}/soil-readings`),
        get<{ data: AmendmentLog[] }>(`/api/gardens/${gardenId}/amendments`).catch(() => ({ data: [] as AmendmentLog[] })),
      ]);
      setGarden(g ?? null);
      setReadings(r?.data ?? []);
      setAmendments(a?.data ?? []);
    } finally {
      setLoading(false);
    }
  }, [gardenId]);

  useEffect(() => { load(); }, [load]);

  if (!isSupporter) {
    return (
      <div style={{ padding: 'var(--sp-6)' }}>
        <UpgradePrompt gateKey="soil" />
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

  const byBedId = readings.reduce<Record<string, SoilReading[]>>((acc, r) => {
    (acc[r.bedId] ??= []).push(r);
    return acc;
  }, {});

  // Default bedId for new readings: last used, else first bed
  const defaultBedId = readings[0]?.bedId ?? beds[0]?.id ?? '';

  const currentBed =
    view.kind === 'per-bed' ? (beds.find(b => b.id === view.bedId) ?? null) : null;

  return (
    <div style={{ maxWidth: 680, margin: '0 auto', padding: 'var(--sp-5)' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--sp-4)' }}>
        <h1 style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 24, color: 'var(--c-text)' }}>
          Soil Readings
        </h1>
        <button
          onClick={() => setForm({ open: true, mode: 'add' })}
          style={saveSt}
        >
          + Log reading
        </button>
      </div>

      {/* All-beds landing */}
      {view.kind === 'all-beds' && (
        <AllBedsView
          beds={beds}
          byBedId={byBedId}
          onSelect={(bedId) => setView({ kind: 'per-bed', bedId })}
        />
      )}

      {/* Per-bed detail */}
      {view.kind === 'per-bed' && currentBed && (
        <PerBedView
          bed={currentBed}
          readings={byBedId[currentBed.id] ?? []}
          amendments={amendments}
          onBack={() => setView({ kind: 'all-beds' })}
          onEdit={(r) => setForm({ open: true, mode: 'edit', reading: r })}
        />
      )}

      {/* Entry form */}
      {form.open && (
        <EntryForm
          beds={beds}
          defaultBedId={view.kind === 'per-bed' ? view.bedId : defaultBedId}
          gardenId={gardenId!}
          initial={
            form.mode === 'edit'
              ? {
                  id:         form.reading.id,
                  bedId:      form.reading.bedId,
                  testDate:   form.reading.testDate,
                  ph:         form.reading.ph?.toString() ?? '',
                  nitrogen:   form.reading.nitrogen?.toString()   ?? '',
                  phosphorus: form.reading.phosphorus?.toString() ?? '',
                  potassium:  form.reading.potassium?.toString()  ?? '',
                  notes:      form.reading.notes ?? '',
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
