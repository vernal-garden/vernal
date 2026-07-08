import { Link } from 'react-router-dom';

export function CanvasHomeButton() {
  return (
    <Link
      to="/gardens"
      style={{
        position: 'fixed',
        top: 16,
        left: 16,
        zIndex: 10,
        display: 'inline-flex',
        alignItems: 'center',
        background: 'rgba(16, 34, 22, 0.88)',
        backdropFilter: 'blur(14px)',
        WebkitBackdropFilter: 'blur(14px)',
        border: '1px solid rgba(100,160,100,0.18)',
        borderRadius: 999,
        padding: '6px 14px',
        boxShadow: '0 8px 32px rgba(0,0,0,0.28), 0 1px 0 rgba(100,160,100,0.12) inset',
        fontSize: 13,
        fontWeight: 600,
        letterSpacing: '0.02em',
        color: '#d4edda',
        textDecoration: 'none',
        cursor: 'pointer',
        transition: 'background 150ms ease',
        userSelect: 'none',
      }}
      onMouseEnter={e => {
        (e.currentTarget as HTMLAnchorElement).style.background = 'rgba(16, 34, 22, 0.70)';
      }}
      onMouseLeave={e => {
        (e.currentTarget as HTMLAnchorElement).style.background = 'rgba(16, 34, 22, 0.88)';
      }}
    >
      Vernal
    </Link>
  );
}
