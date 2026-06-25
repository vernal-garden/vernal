import { useEffect, useRef, useState } from 'react';
import type { Bed, Garden } from '../../hooks/useGarden';
import type { ArmedSeed } from '../../hooks/usePlantings';
import { usePlantSearch } from '../../hooks/usePlantSearch';
import { computeFit } from '../../lib/fit';
import FitLine from './FitLine';
import * as api from '../../lib/api';

interface SeedDetail {
  commonName: string;
  spacingInches: number;
}

interface Props {
  garden: Garden;
  bed: Bed;
  onArm: (seed: ArmedSeed) => void;
  onDisarm: () => void;
  onClose: () => void;
  armedSeed: ArmedSeed | null;
}

export default function PlantPicker({ garden, bed, onArm, onDisarm, onClose, armedSeed }: Props) {
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedSource, setSelectedSource] = useState<'catalogue' | 'personal' | null>(null);
  const [detail, setDetail] = useState<SeedDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const { catalogue, personal, loading } = usePlantSearch(query);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (armedSeed) {
          onDisarm(); // disarm only — keep picker open so user can pick again
        } else {
          onClose(); // nothing armed — close the picker
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [armedSeed, onDisarm, onClose]);

  const handleSelect = async (id: string, source: 'catalogue' | 'personal', fallbackName: string) => {
    if (selectedId === id && selectedSource === source) return;
    setSelectedId(id);
    setSelectedSource(source);
    setDetail(null);
    setDetailLoading(true);
    try {
      const path = source === 'catalogue' ? `/api/catalogue/seeds/${id}` : `/api/seeds/${id}`;
      const data = await api.get<{ commonName?: string; spacingInches?: number }>(path);
      const sd: SeedDetail = {
        commonName: data?.commonName ?? fallbackName,
        spacingInches: data?.spacingInches ?? 6,
      };
      setDetail(sd);
      onArm({ source, id, commonName: sd.commonName, spacingInches: sd.spacingInches });
    } catch {
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  };

  const handleQueryChange = (q: string) => {
    setQuery(q);
    setSelectedId(null);
    setSelectedSource(null);
    setDetail(null);
  };

  const fit = detail ? computeFit({ garden, bed, spacingInches: detail.spacingInches }) : null;

  const isNarrow = window.innerWidth < 1024;

  const panelStyle: React.CSSProperties = isNarrow
    ? {
        position: 'fixed', bottom: 0, left: 0, right: 0, maxHeight: '55vh',
        borderRadius: '12px 12px 0 0', background: '#faf7f2',
        borderTop: '1px solid #d8ceba', boxShadow: '0 -4px 32px rgba(20,40,20,0.12)',
        display: 'flex', flexDirection: 'column',
        fontFamily: 'system-ui, -apple-system, sans-serif', zIndex: 25,
      }
    : {
        position: 'fixed', right: 0, top: 0, bottom: 0, width: 280,
        display: 'flex', flexDirection: 'column',
        background: '#faf7f2', borderLeft: '1px solid #d8ceba',
        boxShadow: '-4px 0 32px rgba(20,40,20,0.12)',
        fontFamily: 'system-ui, -apple-system, sans-serif', zIndex: 25,
      };

  return (
    <div style={panelStyle}>
      {/* Header */}
      <div style={{
        background: '#1c3a28', padding: '16px 20px', flexShrink: 0,
        display: 'flex', alignItems: 'center', gap: 12,
      }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 10, fontWeight: 500, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'rgba(232,244,232,0.6)', marginBottom: 4 }}>
            Add plant to
          </div>
          <div style={{ fontFamily: "'Fraunces', Georgia, serif", fontSize: 16, fontWeight: 600, color: '#e8f4e8' }}>
            {bed.label}
          </div>
        </div>
        <button onClick={onClose} aria-label="Close" style={{
          width: 28, height: 28, borderRadius: '50%', background: 'rgba(255,255,255,0.08)',
          border: '1px solid rgba(255,255,255,0.18)', color: 'rgba(232,244,232,0.7)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: 0,
        }}>×</button>
      </div>

      {/* Search input */}
      <div style={{ padding: '12px 16px', borderBottom: '1px solid #e8e0d0', flexShrink: 0 }}>
        <input
          ref={inputRef}
          value={query}
          onChange={e => handleQueryChange(e.target.value)}
          placeholder="Search plants…"
          style={{
            width: '100%', boxSizing: 'border-box', padding: '8px 12px',
            borderRadius: 8, border: '1px solid #d0c8b8', background: '#fff',
            fontSize: 14, fontFamily: 'inherit', outline: 'none',
          }}
        />
      </div>

      {/* Results list */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
        {query.length < 2 && (
          <div style={{ padding: 16, color: '#9a8e7e', fontSize: 13, textAlign: 'center' }}>
            Type at least 2 characters to search
          </div>
        )}
        {query.length >= 2 && loading && (
          <div style={{ padding: 16, color: '#9a8e7e', fontSize: 13, textAlign: 'center' }}>Searching…</div>
        )}
        {query.length >= 2 && !loading && catalogue.length === 0 && personal.length === 0 && (
          <div style={{ padding: 16, color: '#9a8e7e', fontSize: 13, textAlign: 'center' }}>No plants found</div>
        )}

        {personal.length > 0 && (
          <>
            <GroupLabel>My Seeds</GroupLabel>
            {personal.map(s => (
              <ResultRow
                key={`personal-${s.id}`}
                name={s.commonName}
                spacing={s.spacingInches}
                selected={selectedId === s.id && selectedSource === 'personal'}
                onSelect={() => handleSelect(s.id, 'personal', s.commonName)}
              />
            ))}
          </>
        )}

        {catalogue.length > 0 && (
          <>
            <GroupLabel>{personal.length > 0 ? 'Cambium Catalogue' : 'Catalogue'}</GroupLabel>
            {catalogue.map(s => (
              <ResultRow
                key={`catalogue-${s.id}`}
                name={s.commonName}
                spacing={s.spacingInches}
                selected={selectedId === s.id && selectedSource === 'catalogue'}
                onSelect={() => handleSelect(s.id, 'catalogue', s.commonName)}
              />
            ))}
          </>
        )}
      </div>

      {/* Fit line + placement hint */}
      {(detailLoading || (detail && fit)) && (
        <div style={{ padding: '12px 16px', borderTop: '1px solid #e8e0d0', flexShrink: 0 }}>
          {detailLoading && !detail && (
            <div style={{ fontSize: 13, color: '#9a8e7e', textAlign: 'center' }}>Loading…</div>
          )}
          {detail && fit && (
            <>
              <FitLine fit={fit} name={detail.commonName} spacingInches={detail.spacingInches} />
              <div style={{ marginTop: 8, fontSize: 12, color: '#6a8e6a', textAlign: 'center' }}>
                Click on the bed to place
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      padding: '6px 16px 2px',
      fontSize: 10, fontWeight: 600, letterSpacing: '0.08em',
      textTransform: 'uppercase', color: '#9a8e7e',
    }}>
      {children}
    </div>
  );
}

function ResultRow({
  name, spacing, selected, onSelect,
}: {
  name: string;
  spacing: number | null;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      style={{
        display: 'block', width: '100%', textAlign: 'left',
        padding: '8px 16px', border: 'none', cursor: 'pointer',
        background: selected ? '#e8f0e8' : 'transparent',
        borderLeft: selected ? '3px solid #2d6a4f' : '3px solid transparent',
      }}
    >
      <div style={{ fontSize: 14, color: '#2c3e2c', fontWeight: selected ? 500 : 400 }}>{name}</div>
      {spacing != null && (
        <div style={{ fontSize: 12, color: '#9a8e7e', marginTop: 1 }}>{spacing} in. spacing</div>
      )}
    </button>
  );
}
