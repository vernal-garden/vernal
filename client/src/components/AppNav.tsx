// client/src/components/AppNav.tsx
import { Link, useLocation } from 'react-router-dom';

const NAV_LINKS = [
  { to: '/',          label: 'Gardens' },
  { to: '/catalogue', label: 'Seed Catalogue' },
  { to: '/guide',     label: 'Planting Guide' },
  { to: '/weather',   label: 'Weather' },
  { to: '/account',   label: 'Account' },
] as const;

export default function AppNav() {
  const { pathname } = useLocation();

  return (
    <nav
      style={{
        background: 'var(--c-surface)',
        borderBottom: '1px solid var(--c-border-subtle)',
        display: 'flex',
        alignItems: 'center',
        padding: '0 var(--sp-6)',
        gap: 'var(--sp-1)',
        height: 52,
        overflowX: 'auto',
        flexShrink: 0,
      }}
      aria-label="Main navigation"
    >
      {/* Wordmark */}
      <span style={{
        fontFamily: 'var(--font-display)',
        fontSize: 18,
        fontWeight: 600,
        color: 'var(--c-primary-dark)',
        marginRight: 'var(--sp-5)',
        whiteSpace: 'nowrap',
        flexShrink: 0,
      }}>
        Vernal
      </span>

      {/* Links */}
      {NAV_LINKS.map(({ to, label }) => {
        const active = to === '/'
          ? pathname === '/'
          : pathname.startsWith(to);
        return (
          <Link
            key={to}
            to={to}
            style={{
              fontFamily: 'var(--font-ui)',
              fontSize: 14,
              fontWeight: active ? 600 : 400,
              color: active ? 'var(--c-primary)' : 'var(--c-text-2)',
              textDecoration: 'none',
              padding: 'var(--sp-2) var(--sp-3)',
              borderRadius: 'var(--r-md)',
              background: active ? 'var(--c-primary-subtle)' : 'transparent',
              whiteSpace: 'nowrap',
              transition: 'background 0.12s',
            }}
            aria-current={active ? 'page' : undefined}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
