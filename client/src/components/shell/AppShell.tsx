import { useLayoutEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import AppNav from '../AppNav';
import GuestBanner from '../GuestBanner';
import LifetimeStateBanner from '../lifetime/LifetimeStateBanner';
import MicroFeedbackHost from '../MicroFeedbackHost';
import { useIsMobile } from '../../hooks/useIsMobile';
import BottomTabBar, { TAB_BAR_HEIGHT } from './BottomTabBar';
import MobileTopBar, { TOP_BAR_HEIGHT } from './MobileTopBar';

const SHELL_TOP_MOBILE = `calc(${TOP_BAR_HEIGHT}px + env(safe-area-inset-top))`;
const SHELL_BOTTOM_MOBILE = `calc(${TAB_BAR_HEIGHT}px + env(safe-area-inset-bottom))`;
// Matches the nav's height in AppNav.
const APP_NAV_HEIGHT = 52;

// Layout route for the signed-in app. On mobile it adds the top bar and bottom
// tab bar; on desktop it renders the existing AppNav (except on the canvas).
//
// --shell-top / --shell-bottom are set on <html> rather than on this subtree so
// fixed-position chrome rendered outside the router (UpdateBanner,
// FeedbackWidget) can offset itself above the tab bar.
//
// --shell-content-top is the bottom edge of the top chrome at scroll 0, for
// WhatsNewCard. It differs from --shell-top only on desktop pages other than
// the canvas, where AppNav and the banners are in normal flow.
export default function AppShell() {
  const isMobile = useIsMobile();
  const { pathname } = useLocation();
  const isCanvas = pathname === '/';

  const [bannerHeight, setBannerHeight] = useState(0);
  const [lifetimeBannerHeight, setLifetimeBannerHeight] = useState(0);
  const bannersHeight = bannerHeight + lifetimeBannerHeight;

  // The guest banner is position:fixed on mobile and on the nav-less desktop
  // canvas, so only there does it take space that fixed/padded content must
  // clear. On other desktop pages it sits in normal flow under AppNav and
  // pushes content down by itself.
  const bannerFixed = isMobile || isCanvas;

  useLayoutEffect(() => {
    const style = document.documentElement.style;
    const base = isMobile ? SHELL_TOP_MOBILE : '0px';
    const shellTop = bannerFixed && bannersHeight > 0 ? `calc(${base} + ${bannersHeight}px)` : base;
    style.setProperty('--shell-top', shellTop);
    style.setProperty(
      '--shell-content-top',
      bannerFixed ? shellTop : `${APP_NAV_HEIGHT + bannersHeight}px`,
    );
    style.setProperty('--shell-bottom', isMobile ? SHELL_BOTTOM_MOBILE : '0px');
  }, [isMobile, bannerFixed, bannersHeight]);

  useLayoutEffect(() => () => {
    const style = document.documentElement.style;
    style.removeProperty('--shell-top');
    style.removeProperty('--shell-content-top');
    style.removeProperty('--shell-bottom');
  }, []);

  if (!isMobile) {
    return (
      <>
        {!isCanvas && <AppNav />}
        <GuestBanner fixed={isCanvas} top="0px" onHeightChange={setBannerHeight} />
        <LifetimeStateBanner fixed={isCanvas} top="0px" onHeightChange={setLifetimeBannerHeight} />
        <Outlet />
        {/* Room for the fixed pending-deletion banner so the last content can scroll clear of it. */}
        {!isCanvas && <div aria-hidden="true" style={{ height: 'var(--deletion-banner-h, 0px)' }} />}
        <MicroFeedbackHost />
      </>
    );
  }

  return (
    <>
      <MobileTopBar />
      <GuestBanner fixed top={SHELL_TOP_MOBILE} onHeightChange={setBannerHeight} />
      <LifetimeStateBanner fixed top={SHELL_TOP_MOBILE} onHeightChange={setLifetimeBannerHeight} />
      <main
        style={isCanvas ? undefined : {
          paddingTop: 'var(--shell-top)',
          paddingBottom: 'calc(var(--shell-bottom) + var(--deletion-banner-h, 0px))',
        }}
      >
        <Outlet />
      </main>
      <BottomTabBar />
      <MicroFeedbackHost />
    </>
  );
}
