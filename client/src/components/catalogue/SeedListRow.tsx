// client/src/components/catalogue/SeedListRow.tsx
// One row of the mobile catalogue list: common name, scientific name beneath,
// and a growing summary (maturity days, else spacing) on the right.
import type { BrowseCard } from '../../types/catalogue';

// Maturity days win when known; spacing is the fallback. Null when neither is.
export function growingSummaryText(card: BrowseCard): string | null {
  const min = card.maturityDaysMin ?? null;
  const max = card.maturityDaysMax ?? null;
  if (min !== null && max !== null && min !== max) return `${min}–${max} days`;
  if (min !== null || max !== null) return `${min ?? max} days`;
  const spacing = card.spacingInches ?? null;
  if (spacing !== null) return `${spacing} in. spacing`;
  return null;
}

const ellipsis = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as const;

interface Props {
  card: BrowseCard;
  onClick: () => void;
}

export default function SeedListRow({ card, onClick }: Props) {
  const summary = growingSummaryText(card);
  return (
    <li style={{ borderBottom: '1px solid var(--c-border-subtle)' }}>
      <button
        type="button"
        onClick={onClick}
        style={{
          width: '100%',
          minHeight: 56,
          boxSizing: 'border-box',
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--sp-3)',
          padding: 'var(--sp-2) var(--sp-4)',
          background: 'transparent',
          border: 'none',
          textAlign: 'left',
          cursor: 'pointer',
          fontFamily: 'var(--font-ui)',
          color: 'var(--c-text)',
        }}
      >
        <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 'var(--sp-1)' }}>
          <span style={{ ...ellipsis, fontFamily: 'var(--font-display)', fontSize: 16, fontWeight: 500 }}>
            {card.commonName}
          </span>
          {card.scientificName && (
            <span style={{ ...ellipsis, fontSize: 13, fontStyle: 'italic', color: 'var(--c-text-3)' }}>
              {card.scientificName}
            </span>
          )}
        </span>
        {summary && (
          <span style={{ flexShrink: 0, fontSize: 13, color: 'var(--c-text-2)', whiteSpace: 'nowrap' }}>
            {summary}
          </span>
        )}
      </button>
    </li>
  );
}
