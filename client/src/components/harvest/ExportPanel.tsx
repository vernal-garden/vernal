import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { apiUrl } from '../../lib/api';
import { harvestQuery } from '../../hooks/useHarvests';
import type { SeedParam } from '../../types/harvest';
import BottomSheet from '../shell/BottomSheet';
import { inputStyle, labelStyle, primaryButtonStyle, secondaryTextStyle } from './formStyles';

interface Props {
  isMobile: boolean;
  onClose: () => void;
  // Pre-filled date range from the active filter; empty means all time.
  defaultFrom: string;
  defaultTo: string;
  gardenId: string | null;
  seeds: SeedParam[];
  q: string | null;
  isSupporter: boolean;
}

// CSV export of the harvest log (desktop popover, mobile bottom sheet).
export default function ExportPanel({ isMobile, onClose, defaultFrom, defaultTo, gardenId, seeds, q, isSupporter }: Props) {
  const uid = useId();
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const rootRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Desktop popover: outside click and Escape close it.
  useEffect(() => {
    if (isMobile) return;
    function onPointer(e: PointerEvent) {
      const target = e.target as HTMLElement;
      if (rootRef.current?.contains(target) || target.closest('[data-export-toggle]')) return;
      onCloseRef.current();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCloseRef.current();
    }
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [isMobile]);

  const params = harvestQuery({ gardenId, seeds, q, from: from || null, to: to || null });
  const href = apiUrl(`/api/harvests/export.csv?${params.toString()}`);

  const body = (
    <div style={{ padding: isMobile ? '0 var(--sp-4) var(--sp-4)' : 'var(--sp-4)', fontFamily: 'var(--font-ui)' }}>
      <fieldset style={{ border: 'none', margin: '0 0 var(--sp-4)', padding: 0 }}>
        <legend style={labelStyle}>Format</legend>
        <label style={radioRowStyle}>
          <input type="radio" name={`${uid}-format`} checked readOnly style={radioStyle} />
          CSV
        </label>
        <div style={{ ...radioRowStyle, color: 'var(--c-text-3)' }}>
          <input type="radio" name={`${uid}-format`} disabled aria-label="PDF" style={radioStyle} />
          <span>PDF</span>
          {isSupporter ? (
            <span style={secondaryTextStyle}>Coming soon</span>
          ) : (
            <Link to="/account" style={{ color: 'var(--c-primary)', fontWeight: 600, fontSize: 13, minHeight: 44, display: 'inline-flex', alignItems: 'center' }}>
              Upgrade
            </Link>
          )}
        </div>
      </fieldset>

      <div style={{ display: 'flex', gap: 'var(--sp-3)', marginBottom: 'var(--sp-2)' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <label htmlFor={`${uid}-from`} style={labelStyle}>From</label>
          <input id={`${uid}-from`} type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} style={inputStyle} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <label htmlFor={`${uid}-to`} style={labelStyle}>To</label>
          <input id={`${uid}-to`} type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} style={inputStyle} />
        </div>
      </div>
      <p style={{ ...secondaryTextStyle, margin: '0 0 var(--sp-4)' }}>
        {from || to ? 'Only harvests in this range are exported.' : 'Leave both empty to export every harvest.'}
      </p>

      <a href={href} download onClick={() => onClose()} style={{ ...primaryButtonStyle, width: '100%', boxSizing: 'border-box' }}>
        Download
      </a>
    </div>
  );

  if (isMobile) {
    return (
      <BottomSheet open onClose={onClose} title="Export harvests">
        {body}
      </BottomSheet>
    );
  }

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label="Export harvests"
      style={{
        position: 'absolute',
        top: 'calc(100% + var(--sp-1))',
        right: 0,
        zIndex: 50,
        width: 340,
        background: 'var(--c-surface)',
        border: '1px solid var(--c-border)',
        borderRadius: 'var(--r-lg)',
        boxShadow: 'var(--shadow-lg)',
      }}
    >
      {body}
    </div>
  );
}

const radioRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--sp-2)',
  minHeight: 44,
  fontSize: 14,
  color: 'var(--c-text)',
};

const radioStyle: CSSProperties = { width: 20, height: 20, margin: 0 };
