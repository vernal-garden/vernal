import { useEffect, type CSSProperties } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';

export const ADMIN_SECTIONS = [
  { path: 'seeds', label: 'Seed DB' },
  { path: 'moderation', label: 'Moderation' },
  { path: 'users', label: 'Users' },
  { path: 'features', label: 'Features' },
  { path: 'feedback', label: 'Feedback' },
  { path: 'system', label: 'System' },
] as const;

function sectionFor(pathname: string): string {
  const segment = pathname.replace(/^\/admin\/?/, '').split('/')[0];
  return ADMIN_SECTIONS.find((s) => s.path === segment)?.label ?? 'Admin';
}

const navLinkBase: CSSProperties = {
  display: 'block',
  padding: 'var(--sp-2) var(--sp-4)',
  borderLeft: '3px solid transparent',
  color: 'var(--c-text-2)',
  textDecoration: 'none',
  fontSize: 14,
  lineHeight: '20px',
};

// Layout for /admin/*: fixed sidebar, a top bar with the section name, and a
// main area that scrolls on its own.
export default function AdminShell() {
  const { pathname } = useLocation();
  const section = sectionFor(pathname);

  useEffect(() => {
    const previous = document.title;
    return () => {
      document.title = previous;
    };
  }, []);

  useEffect(() => {
    document.title = `Vernal Admin — ${section}`;
  }, [section]);

  return (
    <div
      style={{
        display: 'flex',
        height: '100dvh',
        overflow: 'hidden',
        background: 'var(--c-bg)',
        color: 'var(--c-text)',
        fontFamily: 'var(--font-ui)',
        fontSize: 14,
      }}
    >
      <aside
        style={{
          width: 220,
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          borderRight: '1px solid var(--c-border)',
          background: 'var(--c-surface)',
          overflowY: 'auto',
        }}
      >
        <div style={{ padding: 'var(--sp-4)', fontSize: 12, color: 'var(--c-text-3)' }}>Vernal Admin</div>
        <nav aria-label="Admin" style={{ flex: 1 }}>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {ADMIN_SECTIONS.map((s) => (
              <li key={s.path}>
                <NavLink
                  to={`/admin/${s.path}`}
                  style={({ isActive }) =>
                    isActive
                      ? {
                          ...navLinkBase,
                          borderLeftColor: 'var(--c-primary)',
                          background: 'var(--c-surface-raised)',
                          color: 'var(--c-text)',
                          fontWeight: 600,
                        }
                      : navLinkBase
                  }
                >
                  {s.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <Link to="/" style={{ ...navLinkBase, padding: 'var(--sp-4)', borderLeft: 'none', color: 'var(--c-text-3)' }}>
          Back to app
        </Link>
      </aside>

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <header
          style={{
            flexShrink: 0,
            padding: 'var(--sp-3) var(--sp-5)',
            borderBottom: '1px solid var(--c-border)',
            background: 'var(--c-surface)',
          }}
        >
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600, lineHeight: '28px', color: 'var(--c-text)' }}>{section}</h1>
        </header>
        <main style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
