import { describe, expect, it } from 'vitest';
import { parseGuideDeepLink, withoutGuideDeepLink } from '../../client/src/lib/guideDeepLink';

const p = (qs: string) => new URLSearchParams(qs);

describe('parseGuideDeepLink', () => {
  it('returns null when no link params are present', () => {
    expect(parseGuideDeepLink(p(''))).toBeNull();
    expect(parseGuideDeepLink(p('foo=1'))).toBeNull();
  });

  it('reads gardenId and season (the bell link)', () => {
    expect(parseGuideDeepLink(p('gardenId=12&season=2027'))).toEqual({ season: 2027, gardenId: '12', open: null });
  });

  it('accepts season without open', () => {
    expect(parseGuideDeepLink(p('season=2026'))).toEqual({ season: 2026, gardenId: null, open: null });
  });

  it('keeps the open param alongside season', () => {
    expect(parseGuideDeepLink(p('open=seed:5&season=2026'))).toEqual({ season: 2026, gardenId: null, open: 'seed:5' });
  });

  it('drops an invalid season but still counts as a link', () => {
    expect(parseGuideDeepLink(p('season=26'))).toEqual({ season: null, gardenId: null, open: null });
    expect(parseGuideDeepLink(p('season=abcd&gardenId=3'))).toEqual({ season: null, gardenId: '3', open: null });
  });

  it('treats empty values as absent', () => {
    expect(parseGuideDeepLink(p('gardenId=&open='))).toEqual({ season: null, gardenId: null, open: null });
  });
});

describe('withoutGuideDeepLink', () => {
  it('removes the link params and keeps the rest', () => {
    expect(withoutGuideDeepLink(p('gardenId=1&season=2027&open=seed:2&x=y')).toString()).toBe('x=y');
  });
});
