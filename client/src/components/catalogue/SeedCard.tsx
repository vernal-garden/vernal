// client/src/components/catalogue/SeedCard.tsx
import React, { useState } from 'react';
import IllustrationImage from './IllustrationImage';
import StarRating from './StarRating';
import type { BrowseCard } from '../../types/catalogue';

interface Props {
  card: BrowseCard;
  onClick: () => void;
}

const cardStyle: React.CSSProperties = {
  background: 'var(--c-surface)',
  border: '1px solid var(--c-border-subtle)',
  borderRadius: 'var(--r-lg)',
  padding: 'var(--sp-4)',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 'var(--sp-2)',
  cursor: 'pointer',
  boxShadow: 'var(--shadow-sm)',
  transition: 'box-shadow 0.15s ease, border-color 0.15s ease',
  position: 'relative',
  textAlign: 'center',
  fontFamily: 'var(--font-ui)',
  outline: 'none',
};

const badgeStyle: React.CSSProperties = {
  position: 'absolute',
  top: 'var(--sp-2)',
  right: 'var(--sp-2)',
  background: 'var(--c-primary-subtle)',
  color: 'var(--c-primary-dark)',
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: '0.05em',
  padding: '2px 6px',
  borderRadius: 'var(--r-full)',
  border: '1px solid var(--c-primary-light)',
  textTransform: 'uppercase' as const,
};

export default function SeedCard({ card, onClick }: Props) {
  const isCommunity = card.kind === 'community';
  const [isHovered, setIsHovered] = useState(false);
  const [isFocused, setIsFocused] = useState(false);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); }
  }

  const dynamicStyle: React.CSSProperties = {
    boxShadow: isHovered ? '0 2px 8px rgba(42,35,24,0.08), 0 1px 2px rgba(42,35,24,0.04)' : '0 1px 2px rgba(42,35,24,0.06)',
    borderColor: isHovered ? '#D2CABF' : '#E5E1DA',
    outline: isFocused ? '2px solid #4A6B40' : 'none',
  };

  return (
    <div
      role="button"
      tabIndex={0}
      style={{ ...cardStyle, ...dynamicStyle }}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onFocus={() => setIsFocused(true)}
      onBlur={() => setIsFocused(false)}
    >
      {isCommunity && <span style={badgeStyle}>Cambium</span>}

      {/* Family label */}
      <span style={{
        fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase',
        color: 'var(--c-text-3)', marginBottom: 'var(--sp-1)',
      }}>
        {card.plantFamily ?? 'Unknown family'}
      </span>

      {/* Illustration */}
      <IllustrationImage illustrationKey={card.illustrationKey} size={72} />

      {/* Common name */}
      <span style={{
        fontFamily: 'var(--font-display)',
        fontSize: 15,
        fontWeight: 500,
        color: 'var(--c-text)',
        lineHeight: 1.3,
      }}>
        {card.commonName}
      </span>

      {/* Stars */}
      {isCommunity ? (
        card.aggregateRating !== null ? (
          <StarRating value={card.aggregateRating} size={14} />
        ) : (
          <span style={{ fontSize: 11, color: 'var(--c-text-3)' }}>No ratings yet</span>
        )
      ) : (
        card.userRating !== null ? (
          <StarRating value={card.userRating} size={14} />
        ) : (
          <span style={{ fontSize: 11, color: 'var(--c-text-3)' }}>Unrated</span>
        )
      )}

      {/* Favourite indicator for personal */}
      {!isCommunity && card.isFavourite && (
        <span style={{ fontSize: 12, color: 'var(--c-secondary)', position: 'absolute', top: 'var(--sp-2)', left: 'var(--sp-2)' }} aria-label="Favourite">♥</span>
      )}
    </div>
  );
}
