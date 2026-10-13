import type { GuideRow } from '../../types/plantingGuide';
import { rowName, sowType } from '../../lib/guideModel';
import { tagStyle } from './styles';

interface Props {
  row: GuideRow;
  gardenName: string | null; // shown only when the user has more than one garden
  compact?: boolean;
}

export function SowTags({ row }: { row: GuideRow }) {
  return <span style={tagStyle}>{sowType(row) === 'indoors' ? 'Indoors' : 'Direct'}</span>;
}

// Plant name block used by every view. The caller makes it clickable.
export default function RowLabel({ row, gardenName, compact }: Props) {
  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, textAlign: 'left' }}>
      <span
        style={{
          fontFamily: 'var(--font-ui)',
          fontSize: compact ? 13 : 14,
          fontWeight: 600,
          color: 'var(--c-text)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {rowName(row)}
      </span>
      {row.scientificName && (
        <span
          style={{
            fontFamily: 'var(--font-ui)',
            fontSize: 12,
            fontWeight: 400,
            fontStyle: 'italic',
            color: 'var(--c-text-3)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {row.scientificName}
        </span>
      )}
      <span style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--sp-1)', alignItems: 'center' }}>
        <SowTags row={row} />
        {gardenName && (
          <span style={{ fontSize: 11, color: 'var(--c-text-3)', fontFamily: 'var(--font-ui)' }}>{gardenName}</span>
        )}
      </span>
    </span>
  );
}
