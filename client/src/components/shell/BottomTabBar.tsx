import type { ComponentType } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { CanvasIcon, CatalogueIcon, GardensIcon, HarvestIcon, PlantingIcon } from './icons';

// Height of the bar itself, excluding the bottom safe-area inset.
export const TAB_BAR_HEIGHT = 56;

interface Tab {
  key: string;
  label: string;
  to: string;
  icon: ComponentType;
  match: (pathname: string) => boolean;
}

export const TABS: Tab[] = [
  { key: 'gardens',   label: 'Gardens',   to: '/gardens',   icon: GardensIcon,
    match: (p) => p === '/gardens' },
  { key: 'canvas',    label: 'Canvas',    to: '/',          icon: CanvasIcon,
    match: (p) => p === '/' || p.startsWith('/garden/') },
  { key: 'planting',  label: 'Planting',  to: '/guide',     icon: PlantingIcon,
    match: (p) => p.startsWith('/guide') },
  { key: 'catalogue', label: 'Catalogue', to: '/catalogue', icon: CatalogueIcon,
    match: (p) => p.startsWith('/catalogue') },
  { key: 'harvest',   label: 'Harvest',   to: '/harvest',   icon: HarvestIcon,
    match: (p) => p.startsWith('/harvest') },
];

export default function BottomTabBar() {
  const { pathname } = useLocation();

  return (
    <nav
      aria-label="Primary"
      style={{
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 1000,
        display: 'flex',
        background: 'var(--c-surface)',
        borderTop: '1px solid var(--c-border-subtle)',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      {TABS.map(({ key, label, to, icon: TabIcon, match }) => {
        const active = match(pathname);
        return (
          <Link
            key={key}
            to={to}
            aria-current={active ? 'page' : undefined}
            style={{
              flex: '1 1 0',
              minWidth: 0,
              minHeight: TAB_BAR_HEIGHT,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 2,
              color: active ? 'var(--c-primary)' : 'var(--c-text-3)',
              textDecoration: 'none',
              fontFamily: 'var(--font-ui)',
              fontSize: 11,
              fontWeight: 500,
              lineHeight: 1.2,
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            <TabIcon />
            <span>{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
