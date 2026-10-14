import { Link } from 'react-router-dom';
import { PlantingIcon } from '../shell/icons';
import { linkStyle, primaryButtonStyle } from './styles';

// The whole page body for a season with no harvests and no sowing done.
export default function MetricsEmptyState() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        textAlign: 'center',
        padding: 'var(--sp-8) var(--sp-4)',
        fontFamily: 'var(--font-ui)',
      }}
    >
      <div
        aria-hidden="true"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 56,
          height: 56,
          borderRadius: 'var(--r-full)',
          background: 'var(--c-primary-subtle)',
          color: 'var(--c-primary)',
          marginBottom: 'var(--sp-4)',
        }}
      >
        <PlantingIcon width={28} height={28} />
      </div>
      <p style={{ margin: '0 0 var(--sp-5)', maxWidth: 380, fontSize: 16, lineHeight: 1.6, color: 'var(--c-text-2)' }}>
        Your season&rsquo;s story starts here. Log your first harvest and your data will appear.
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'center', gap: 'var(--sp-3)' }}>
        <Link to="/harvest?log=new" style={primaryButtonStyle}>Log a harvest</Link>
        <Link to="/guide" style={linkStyle}>View planting guide</Link>
      </div>
    </div>
  );
}
