import { describe, it, expect } from 'vitest';
import { markerStyleFor } from '../../client/src/lib/plantingMarkerStyle';

describe('markerStyleFor', () => {
  it('planned is faint, dashed, and shows the stage-5 art', () => {
    expect(markerStyleFor({ state: 'planned', growth: { stage: null, anchored: false } })).toEqual({
      circleOpacity: 0.4,
      dashed: { widthPx: 1.5, dashPx: [4, 3] },
      artStage: 5,
    });
  });

  it('growing anchored uses its stage', () => {
    expect(markerStyleFor({ state: 'growing', growth: { stage: 3, anchored: true } })).toEqual({
      circleOpacity: 0.88,
      dashed: null,
      artStage: 3,
    });
  });

  it('growing unanchored has no art stage', () => {
    expect(markerStyleFor({ state: 'growing', growth: { stage: 3, anchored: false } }).artStage).toBeNull();
  });
});
