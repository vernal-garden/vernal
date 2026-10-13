import { useLayoutEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import AppNav from '../AppNav';
import MicroFeedbackHost from '../MicroFeedbackHost';
import { useIsMobile } from '../../hooks/useIsMobile';
import BottomTabBar, { TAB_BAR_HEIGHT } from './BottomTabBar';
import MobileTopBar, { TOP_BAR_HEIGHT } from './MobileTopBar';

const SHELL_TOP_MOBILE = `calc(${TOP_BAR_HEIGHT}px + env(safe-area-inset-top))`;
const SHELL_BOTTOM_MOBILE = `calc(${TAB_BAR_HEIGHT}px + env(safe-area-inset-bottom))`;

// Layout route for the signed-in app. On mobile it adds the top bar and bottom
// tab bar; on desktop it renders the existing AppNav (except on the canvas).
//
// --shell-top / --shell-bottom are set on <html> rather than on this subtree so
// fixed-position chrome rendered outside the router (UpdateBanner,
// FeedbackWidget) can offset itself above the tab bar.
export default function AppShell() {
  const isMobile = useIsMobile();
  const { pathname } = useLocation();
  const isCanvas = pathname === '/';

  useLayoutEffect(() => {
    const style = document.documentElement.style;
    style.setProperty('--shell-top', isMobile ? SHELL_TOP_MOBILE : '0px');
    style.setProperty('--shell-bottom', isMobile ? SHELL_BOTTOM_MOBILE : '0px');
  }, [isMobile]);

  useLayoutEffect(() => () => {
    const style = document.documentElement.style;
    style.removeProperty('--shell-top');
    style.removeProperty('--shell-bottom');
  }, []);

  if (!isMobile) {
    return (
      <>
        {!isCanvas && <AppNav />}
        <Outlet />
        <MicroFeedbackHost />
      </>
    );
  }

  return (
    <>
      <MobileTopBar />
      <main
        style={isCanvas ? undefined : {
          paddingTop: 'var(--shell-top)',
          paddingBottom: 'var(--shell-bottom)',
        }}
      >
        <Outlet />
      </main>
      <BottomTabBar />
      <MicroFeedbackHost />
    </>
  );
}
