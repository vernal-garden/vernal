import { Link } from 'react-router-dom';
import type { GuideGarden } from '../../types/plantingGuide';
import { gardenSourceLabel } from '../../lib/guideModel';

interface Props {
  garden: GuideGarden;
  isAccount: boolean;
}

// Low-contrast "Zone 7b · Raleigh, NC" line with the frost-date source.
export default function ZoneStrip({ garden, isAccount }: Props) {
  const zoneText = `Zone ${garden.zone}${garden.zoneLocationLabel ? ` · ${garden.zoneLocationLabel}` : ''}`;
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        columnGap: 'var(--sp-3)',
        fontFamily: 'var(--font-ui)',
        fontSize: 13,
        color: 'var(--c-text-3)',
      }}
    >
      {isAccount ? (
        <Link
          to="/account"
          style={{ minHeight: 44, display: 'inline-flex', alignItems: 'center', color: 'var(--c-text-3)', textDecoration: 'underline' }}
        >
          {zoneText}
        </Link>
      ) : (
        <span style={{ minHeight: 44, display: 'inline-flex', alignItems: 'center' }}>{zoneText}</span>
      )}
      <span>{gardenSourceLabel(garden)}</span>
    </div>
  );
}
