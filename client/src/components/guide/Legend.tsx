import { WINDOW_NAMES } from '../../lib/guideModel';
import { barFill, type BarKind } from './WindowBar';

const KINDS: BarKind[] = ['indoorStart', 'transplant', 'directSow', 'harvest', 'none'];

export default function Legend() {
  return (
    <ul
      aria-label="Legend"
      style={{
        listStyle: 'none',
        margin: 0,
        padding: 0,
        display: 'flex',
        flexWrap: 'wrap',
        gap: 'var(--sp-2) var(--sp-4)',
        fontFamily: 'var(--font-ui)',
        fontSize: 12,
        color: 'var(--c-text-2)',
      }}
    >
      {KINDS.map((kind) => (
        <li key={kind} style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)' }}>
          <span
            aria-hidden="true"
            style={{ display: 'inline-block', boxSizing: 'border-box', width: 28, height: 12, borderRadius: 'var(--r-full)', ...barFill(kind) }}
          />
          {WINDOW_NAMES[kind]}
        </li>
      ))}
    </ul>
  );
}
