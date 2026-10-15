import { Link, matchPath, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import NotificationBell from '../NotificationBell';
import { BackIcon } from './icons';

// Height of the bar itself, excluding the top safe-area inset.
export const TOP_BAR_HEIGHT = 52;

const SOIL_PATTERN = '/garden/:gardenId/soil';
const AMENDMENTS_PATTERN = '/garden/:gardenId/amendments';
const HARVEST_DETAIL_PATTERN = '/harvest/:entryId';
const COMPARE_PATTERN = '/data/compare';

// Route pattern → top-bar title.
export const ROUTE_TITLES: Record<string, string> = {
  '/': 'Garden',
  '/gardens': 'My Gardens',
  '/catalogue': 'Seed Catalogue',
  '/guide': 'Planting Guide',
  '/data': 'Data',
  '/weather': 'Weather',
  '/harvest': 'Harvest',
  '/account': 'Account',
  '/about': 'About',
  [SOIL_PATTERN]: 'Soil',
  [AMENDMENTS_PATTERN]: 'Amendments',
  [HARVEST_DETAIL_PATTERN]: 'Harvest',
  [COMPARE_PATTERN]: 'Compare seasons',
};

const DETAIL_PATTERNS = [SOIL_PATTERN, AMENDMENTS_PATTERN, HARVEST_DETAIL_PATTERN, COMPARE_PATTERN];

function titleFor(pathname: string): string {
  for (const [pattern, title] of Object.entries(ROUTE_TITLES)) {
    if (matchPath(pattern, pathname)) return title;
  }
  return 'Vernal';
}

const SQUARE_44 = {
  width: 44,
  height: 44,
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
} as const;

export default function MobileTopBar() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { state, account } = useAuth();

  const isDetail = DETAIL_PATTERNS.some((pattern) => matchPath(pattern, pathname));

  function goBack() {
    // react-router stores the history stack index on history.state.idx; 0 means
    // this entry was the first in the app (e.g. a deep link), so -1 would leave Vernal.
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) navigate(-1);
    else navigate(matchPath(COMPARE_PATTERN, pathname) ? '/data' : '/');
  }

  let right;
  if (state.kind === 'loading') {
    // Same footprint as bell + avatar so the title doesn't shift when auth resolves.
    right = <div aria-hidden="true" style={{ ...SQUARE_44, width: 44 * 2 + 8 }} />;
  } else if (account) {
    const initial = (account.email ?? '?').charAt(0).toUpperCase();
    right = (
      <>
        <NotificationBell />
        <Link
          to="/account"
          aria-label="Account"
          style={{
            ...SQUARE_44,
            borderRadius: 'var(--r-full)',
            background: 'var(--c-primary-subtle)',
            color: 'var(--c-primary-dark)',
            fontFamily: 'var(--font-ui)',
            fontSize: 16,
            fontWeight: 600,
            textDecoration: 'none',
          }}
        >
          {initial}
        </Link>
      </>
    );
  } else {
    right = (
      <Link
        to="/login"
        style={{
          minHeight: 44,
          minWidth: 44,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '0 var(--sp-3)',
          color: 'var(--c-primary)',
          fontFamily: 'var(--font-ui)',
          fontSize: 14,
          fontWeight: 600,
          textDecoration: 'none',
          whiteSpace: 'nowrap',
        }}
      >
        Sign in
      </Link>
    );
  }

  return (
    <header
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 1000,
        boxSizing: 'border-box',
        height: `calc(${TOP_BAR_HEIGHT}px + env(safe-area-inset-top))`,
        paddingTop: 'env(safe-area-inset-top)',
        paddingLeft: isDetail ? 'var(--sp-1)' : 'var(--sp-4)',
        paddingRight: 'var(--sp-2)',
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--sp-2)',
        background: 'var(--c-surface)',
        borderBottom: '1px solid var(--c-border-subtle)',
      }}
    >
      {isDetail && (
        <button
          type="button"
          aria-label="Back"
          onClick={goBack}
          style={{
            ...SQUARE_44,
            padding: 0,
            border: 'none',
            background: 'transparent',
            color: 'var(--c-text)',
            cursor: 'pointer',
            borderRadius: 'var(--r-full)',
          }}
        >
          <BackIcon />
        </button>
      )}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          margin: 0,
          fontFamily: 'var(--font-display)',
          fontSize: 18,
          fontWeight: 600,
          color: 'var(--c-text)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {titleFor(pathname)}
      </div>
      {right}
    </header>
  );
}
