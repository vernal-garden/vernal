import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { GuideGarden, GuideOverrides, GuideRow, GuideWindow, OverrideField } from '../../types/plantingGuide';
import { formatRange } from '../../lib/guideDates';
import { isDone, rowName, seedParam, sourceLabel } from '../../lib/guideModel';
import BottomSheet from '../shell/BottomSheet';
import { CloseIcon } from '../shell/icons';
import { SowTags } from './RowLabel';
import ZoneStrip from './ZoneStrip';
import { iconButtonStyle, linkStyle, sectionHeadingStyle, tagStyle, textButtonStyle } from './styles';

interface Props {
  row: GuideRow;
  garden: GuideGarden | undefined;
  readOnly: boolean;
  isAccount: boolean;
  isMobile: boolean;
  onClose: () => void;
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
  setOverrides: (row: GuideRow, partial: Partial<GuideOverrides>) => Promise<void>;
  setDone: (row: GuideRow, done: boolean) => Promise<void>;
}

export default function PlantSchedule(props: Props) {
  const { row, isMobile, onClose, onPrev, onNext } = props;
  const name = rowName(row);

  if (isMobile) {
    return (
      <BottomSheet open onClose={onClose} title={name} ariaLabel={`${name} schedule`}>
        <div style={{ padding: 'var(--sp-2) var(--sp-4) var(--sp-4)' }}>
          <ScheduleBody {...props} />
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--sp-2)', marginTop: 'var(--sp-5)' }}>
            <button type="button" onClick={onPrev ?? undefined} disabled={!onPrev} style={{ ...textButtonStyle, opacity: onPrev ? 1 : 0.4 }}>
              ‹ Previous plant
            </button>
            <button type="button" onClick={onNext ?? undefined} disabled={!onNext} style={{ ...textButtonStyle, opacity: onNext ? 1 : 0.4 }}>
              Next plant ›
            </button>
          </div>
        </div>
      </BottomSheet>
    );
  }

  return <DesktopModal {...props} />;
}

// Same overlay pattern as SeedDetailOverlay: backdrop click and Escape close,
// focus moves to the close button, body scroll is locked.
function DesktopModal(props: Props) {
  const { row, onClose, onPrev, onNext } = props;
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    return () => {
      document.body.style.overflow = prevOverflow;
      previouslyFocused?.focus?.();
    };
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onCloseRef.current();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 200,
        background: 'rgba(42,35,24,0.55)', // --c-text at 55%, as SeedDetailOverlay
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: '40px 16px',
        overflowY: 'auto',
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${rowName(row)} schedule`}
        style={{
          width: '100%',
          maxWidth: 600,
          background: 'var(--c-surface)',
          borderRadius: 'var(--r-xl)',
          boxShadow: 'var(--shadow-lg)',
          padding: 'var(--sp-5) var(--sp-6) var(--sp-6)',
          fontFamily: 'var(--font-ui)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--sp-1)', marginBottom: 'var(--sp-1)' }}>
          <button type="button" aria-label="Previous plant" onClick={onPrev ?? undefined} disabled={!onPrev} style={{ ...iconButtonStyle, opacity: onPrev ? 1 : 0.4 }}>
            ‹
          </button>
          <button type="button" aria-label="Next plant" onClick={onNext ?? undefined} disabled={!onNext} style={{ ...iconButtonStyle, opacity: onNext ? 1 : 0.4 }}>
            ›
          </button>
          <button ref={closeRef} type="button" aria-label="Close" onClick={onClose} style={{ ...iconButtonStyle, background: 'var(--c-surface-raised)' }}>
            <CloseIcon />
          </button>
        </div>
        <ScheduleBody {...props} showTitle />
      </div>
    </div>
  );
}

function ScheduleBody({
  row, garden, readOnly, isAccount, setOverrides, setDone, showTitle,
}: Props & { showTitle?: boolean }) {
  const [doneError, setDoneError] = useState<string | null>(null);
  const transplants = row.weeksToTransplant != null;
  const { indoorStart, transplant, directSow, harvest } = row.windows;
  const noSowingWindows = !indoorStart && !transplant && !directSow;

  async function toggleDone(done: boolean) {
    setDoneError(null);
    try {
      await setDone(row, done);
    } catch {
      setDoneError("Couldn't save. Try again.");
    }
  }

  const fieldProps = { row, readOnly, isAccount, setOverrides };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)' }}>
      {/* Header */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-1)' }}>
        {showTitle && (
          <h2 style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 600, color: 'var(--c-text)' }}>
            {rowName(row)}
          </h2>
        )}
        {row.scientificName && (
          <p style={{ margin: 0, fontStyle: 'italic', fontSize: 14, color: 'var(--c-text-2)' }}>{row.scientificName}</p>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-3)', flexWrap: 'wrap' }}>
          <SowTags row={row} />
          <Link to={`/catalogue?open=${seedParam(row)}`} style={linkStyle}>
            View in seed catalogue
          </Link>
        </div>
      </div>

      {garden && <ZoneStrip garden={garden} isAccount={isAccount} />}

      {!readOnly && (
        <div>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--sp-2)', minHeight: 44, cursor: 'pointer', fontSize: 14, color: 'var(--c-text)' }}>
            <input
              type="checkbox"
              checked={isDone(row)}
              onChange={(e) => void toggleDone(e.target.checked)}
              style={{ width: 20, height: 20, accentColor: 'var(--c-primary)' }}
            />
            Done for this season
          </label>
          {doneError && <p role="alert" style={{ margin: 0, fontSize: 13, color: 'var(--c-danger)' }}>{doneError}</p>}
        </div>
      )}

      {noSowingWindows && row.missingReason && (
        <p style={{ margin: 0, fontSize: 14, color: 'var(--c-text-2)', background: 'var(--c-surface-raised)', padding: 'var(--sp-3)', borderRadius: 'var(--r-md)' }}>
          We don&rsquo;t have planting dates for this one yet. Add your own to track it here.
        </p>
      )}

      {transplants && (
        <>
          <DateSection title="Start indoors" field="indoorStart" window={indoorStart} {...fieldProps} />
          <DateSection title="Transplant out" field="transplant" window={transplant} {...fieldProps}>
            {row.frostTolerance === 'none' && (
              <p style={{ margin: 0, fontSize: 13, color: 'var(--c-text-2)' }}>
                Wait until after your last frost date before transplanting.
              </p>
            )}
          </DateSection>
        </>
      )}
      {!transplants && <DateSection title="Direct sow" field="directSow" window={directSow} {...fieldProps} />}

      {row.successionIntervalWeeks != null && (
        <section style={sectionStyle}>
          <h3 style={sectionHeadingStyle}>Succession</h3>
          <p style={{ margin: 0, fontSize: 14, color: 'var(--c-text)' }}>
            Succession sow every {row.successionIntervalWeeks} week{row.successionIntervalWeeks === 1 ? '' : 's'} for a continuous harvest.
          </p>
        </section>
      )}

      <section style={sectionStyle}>
        <h3 style={sectionHeadingStyle}>Harvest</h3>
        <p style={{ margin: 0, fontSize: 15, fontWeight: 600, color: 'var(--c-text)' }}>
          {harvest ? formatRange(harvest.start, harvest.end) : 'No dates yet'}
        </p>
        {row.maturityDaysMin != null && row.maturityDaysMax != null && (
          <p style={{ margin: 0, fontSize: 14, color: 'var(--c-text-2)' }}>
            Ready in approximately{' '}
            {row.maturityDaysMin === row.maturityDaysMax ? row.maturityDaysMin : `${row.maturityDaysMin}–${row.maturityDaysMax}`} days
          </p>
        )}
        <p style={{ margin: 0, fontSize: 12, color: 'var(--c-text-3)' }}>
          Harvest windows are estimates — actual timing depends on your conditions.
        </p>
      </section>
    </div>
  );
}

const sectionStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--sp-2)',
  paddingTop: 'var(--sp-3)',
  borderTop: '1px solid var(--c-border-subtle)',
};

interface DateSectionProps {
  title: string;
  field: OverrideField;
  window: GuideWindow | null;
  row: GuideRow;
  readOnly: boolean;
  isAccount: boolean;
  setOverrides: (row: GuideRow, partial: Partial<GuideOverrides>) => Promise<void>;
  children?: ReactNode;
}

function DateSection({ title, field, window, row, readOnly, isAccount, setOverrides, children }: DateSectionProps) {
  const override = row.overrides?.[field] ?? null;
  const [draft, setDraft] = useState(override ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = `guide-${field}-${row.gardenId}-${row.seedId ?? `c${row.cambiumSeedId}`}`;

  useEffect(() => {
    setDraft(override ?? '');
  }, [override]);

  async function save(value: string | null) {
    setError(null);
    setSaving(true);
    try {
      await setOverrides(row, { [field]: value });
    } catch {
      setError("Couldn't save this date. Try again.");
      setDraft(override ?? '');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section style={sectionStyle} aria-label={title}>
      <h3 style={sectionHeadingStyle}>{title}</h3>
      <p style={{ margin: 0, fontSize: 15, fontWeight: 600, color: 'var(--c-text)' }}>
        {window ? formatRange(window.start, window.end) : 'No dates yet'}
      </p>
      <p style={{ margin: 0, fontSize: 13, color: 'var(--c-text-3)' }}>{sourceLabel(window?.source ?? null)}</p>
      {children}

      {isAccount ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)', flexWrap: 'wrap' }}>
          <label htmlFor={inputId} style={{ fontSize: 14, color: 'var(--c-text-2)' }}>
            Your date
          </label>
          <input
            id={inputId}
            type="date"
            value={draft}
            disabled={readOnly || saving}
            onChange={(e) => {
              const value = e.target.value;
              setDraft(value);
              if (value === '' || /^\d{4}-\d{2}-\d{2}$/.test(value)) void save(value || null);
            }}
            style={{
              minHeight: 44,
              padding: '0 var(--sp-3)',
              fontFamily: 'var(--font-ui)',
              fontSize: 14,
              color: 'var(--c-text)',
              background: 'var(--c-surface)',
              border: '1px solid var(--c-border)',
              borderRadius: 'var(--r-md)',
            }}
          />
          {override && (
            <>
              <span style={{ ...tagStyle, color: 'var(--c-primary-dark)', background: 'var(--c-primary-subtle)', borderColor: 'var(--c-primary-light)' }}>
                Custom date set
              </span>
              <button type="button" disabled={readOnly || saving} onClick={() => void save(null)} style={textButtonStyle}>
                Reset to recommended
              </button>
            </>
          )}
        </div>
      ) : (
        <Link to="/login" style={linkStyle}>
          Sign in to set your own dates
        </Link>
      )}
      {error && <p role="alert" style={{ margin: 0, fontSize: 13, color: 'var(--c-danger)' }}>{error}</p>}
    </section>
  );
}
