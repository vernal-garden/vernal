import { Link } from 'react-router-dom';
import type { AmendmentLatest, MetricsGarden, PaidMetrics } from '../../types/metrics';
import { shortDate } from '../../lib/guideDates';
import { bodyTextStyle, cardStyle, cardTitleStyle, linkStyle, plural, secondaryTextStyle } from './styles';

// ED: replace with final copy
const TYPE_LABEL: Record<string, string> = {
  fertilizer_synthetic: 'synthetic fertilizer',
  fertilizer_organic: 'organic fertilizer',
  compost_manure: 'compost or manure',
  lime: 'lime',
  sulphur: 'sulfur',
  mulch: 'mulch',
  other: 'other',
};

const COVERAGE_LISTED_MAX = 3;
const COVERAGE_SHOWN = 2;

function typeLabel(type: string): string {
  return TYPE_LABEL[type] ?? type;
}

// "A", "A and B", "A, B and C"
function joinAnd(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

interface Props {
  amendments: PaidMetrics['amendments'];
  gardens: MetricsGarden[];
}

// Amendment applications this season.
export default function AmendmentSummaryCard({ amendments, gardens }: Props) {
  const firstGarden = gardens[0];
  const multiGarden = gardens.length >= 2;
  const { applicationCount, bedCount, seasonBedCount, latest, byType, unamendedBeds } = amendments;

  function bedName(label: string, gardenName: string): string {
    // ED: replace with final copy
    const name = label.trim() === '' ? 'Unnamed bed' : label;
    return multiGarden ? `${name} (${gardenName})` : name;
  }

  function leadLine(l: AmendmentLatest): string {
    // A bare number says nothing, so the amount shows only with its unit.
    const amount = l.amount !== null && l.amountUnit ? `, ${l.amount} ${l.amountUnit}` : '';
    const names = l.beds.map((b) => bedName(b.label, l.gardenName));
    const where =
      names.length === 0
        ? // ED: replace with final copy
          `in ${l.gardenName}`
        : names.length <= 2
          ? // ED: replace with final copy
            `on ${joinAnd(names)}`
          : // ED: replace with final copy
            `on ${names.length} beds`;
    // ED: replace with final copy
    return `Last applied ${shortDate(l.applicationDate)}: ${l.productName} (${typeLabel(l.amendmentType)})${amount} ${where}.`;
  }

  // ED: replace with final copy
  const applications = plural(applicationCount, 'application', 'applications');
  let seasonLine: string;
  if (seasonBedCount === 0) {
    // ED: replace with final copy
    seasonLine = `${applications} this season`;
  } else if (unamendedBeds.length === 0) {
    seasonLine =
      seasonBedCount === 1
        ? // ED: replace with final copy
          `${applications} on your 1 bed this season`
        : // ED: replace with final copy
          `${applications} on all ${seasonBedCount} beds this season`;
  } else {
    // ED: replace with final copy
    seasonLine = `${applications} on ${bedCount} of ${seasonBedCount} ${seasonBedCount === 1 ? 'bed' : 'beds'} this season`;
  }

  const typeLine = byType.map((t) => `${t.count} ${typeLabel(t.amendmentType)}`).join(' · ');

  let coverageLine: string | null = null;
  if (unamendedBeds.length > 0) {
    const names = unamendedBeds.map((b) => bedName(b.label, b.gardenName));
    // Up to three names are listed in full; beyond that, two names and a count.
    const list =
      names.length > COVERAGE_LISTED_MAX
        ? // ED: replace with final copy
          `${names.slice(0, COVERAGE_SHOWN).join(', ')} and ${names.length - COVERAGE_SHOWN} more beds`
        : joinAnd(names);
    // ED: replace with final copy
    coverageLine = `Nothing applied yet: ${list}`;
  } else if (seasonBedCount > 0) {
    // ED: replace with final copy
    coverageLine = 'Every bed has had something this season.';
  }

  const secondary = { ...secondaryTextStyle, margin: 0 };

  return (
    <section aria-labelledby="metrics-amendments-title" style={cardStyle}>
      {/* ED: replace with final copy */}
      <h2 id="metrics-amendments-title" style={cardTitleStyle}>Amendments</h2>
      {applicationCount === 0 ? (
        <>
          {/* ED: replace with final copy */}
          <p style={bodyTextStyle}>No amendments logged this season.</p>
          {firstGarden && (
            <Link to={`/garden/${firstGarden.id}/amendments`} style={{ ...linkStyle, alignSelf: 'flex-start', marginTop: 'auto' }}>
              {/* ED: replace with final copy */}
              Log an amendment
            </Link>
          )}
        </>
      ) : (
        <>
          {latest && <p style={bodyTextStyle}>{leadLine(latest)}</p>}
          <p style={secondary}>{seasonLine}</p>
          {typeLine && <p style={secondary}>{typeLine}</p>}
          {coverageLine && <p style={secondary}>{coverageLine}</p>}
          {latest && (
            <Link to={`/garden/${latest.gardenId}/amendments`} style={{ ...linkStyle, alignSelf: 'flex-start', marginTop: 'auto' }}>
              {/* ED: replace with final copy */}
              View amendment log
            </Link>
          )}
        </>
      )}
    </section>
  );
}
