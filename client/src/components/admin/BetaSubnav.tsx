import type { CSSProperties } from 'react';
import { NavLink } from 'react-router-dom';
import { ADMIN_BETA_COPY as COPY } from '../../lib/betaCopy';

const linkBase: CSSProperties = {
  paddingBottom: 'var(--sp-1)',
  borderBottom: '2px solid transparent',
  color: 'var(--c-text-2)',
  textDecoration: 'none',
  fontSize: 14,
  lineHeight: '20px',
};

// Matches the sidebar's active link: full text colour, bold, primary rule.
const linkStyle = ({ isActive }: { isActive: boolean }): CSSProperties =>
  isActive
    ? { ...linkBase, borderBottomColor: 'var(--c-primary)', color: 'var(--c-text)', fontWeight: 600 }
    : linkBase;

// Switches between the two Beta pages. NavLink sets aria-current="page" on the open one.
export default function BetaSubnav() {
  return (
    <nav aria-label="Beta pages" style={{ display: 'flex', gap: 'var(--sp-4)' }}>
      <NavLink to="/admin/beta" end style={linkStyle}>
        {COPY.subnav.access}
      </NavLink>
      <NavLink to="/admin/beta/lifetime" style={linkStyle}>
        {COPY.subnav.lifetime}
      </NavLink>
    </nav>
  );
}
