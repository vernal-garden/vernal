// Planting Guide deep-link params: ?season=<year>, ?gardenId=<id>,
// ?open=seed:<id> | cambium:<id>. Pure module: no React, no window access.

export interface GuideDeepLink {
  season: number | null;   // a 4-digit year, else null
  gardenId: string | null; // applied only if it's one of the user's gardens
  open: string | null;     // matched against the rows by the page
}

export const GUIDE_LINK_PARAMS = ['season', 'gardenId', 'open'] as const;

const SEASON_RE = /^\d{4}$/;

interface ParamReader {
  get(name: string): string | null;
}

// null when none of the deep-link params is present. A present but invalid
// season still counts as a link (so it gets cleared from the URL).
export function parseGuideDeepLink(params: ParamReader): GuideDeepLink | null {
  const s = params.get('season');
  const g = params.get('gardenId');
  const o = params.get('open');
  if (s === null && g === null && o === null) return null;
  return {
    season: s !== null && SEASON_RE.test(s) ? Number(s) : null,
    gardenId: g !== null && g !== '' ? g : null,
    open: o !== null && o !== '' ? o : null,
  };
}

// A copy of the params with the deep-link params removed; others are kept.
export function withoutGuideDeepLink(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const key of GUIDE_LINK_PARAMS) next.delete(key);
  return next;
}
