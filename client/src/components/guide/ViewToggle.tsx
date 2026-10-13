import type { GuideView } from '../../lib/guideModel';
import { segmentGroupStyle, segmentStyle } from './styles';

const VIEWS: { value: GuideView; label: string }[] = [
  { value: 'calendar', label: 'Calendar' },
  { value: 'timeline', label: 'Timeline' },
  { value: 'list', label: 'List' },
];

interface Props {
  view: GuideView;
  onChange: (view: GuideView) => void;
}

export default function ViewToggle({ view, onChange }: Props) {
  return (
    <div role="group" aria-label="View" style={segmentGroupStyle}>
      {VIEWS.map((v) => (
        <button
          key={v.value}
          type="button"
          aria-pressed={view === v.value}
          onClick={() => onChange(v.value)}
          style={segmentStyle(view === v.value)}
        >
          {v.label}
        </button>
      ))}
    </div>
  );
}
