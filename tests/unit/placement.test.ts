import { describe, it, expect } from 'vitest';
import { lastStartMethod, placementFollowUp } from '../../client/src/lib/placement';
import type { ArmedSeed, Planting, StartMethod } from '../../client/src/hooks/usePlantings';

function planting(id: string, seedId: string | null, startMethod: StartMethod, companionSeedId: string | null = null): Planting {
  return { id, bedId: 'b1', seedId, cambiumSeedId: null, companionSeedId, startMethod } as Planting;
}

const tomato: ArmedSeed = {
  source: 'personal', id: '7', commonName: 'Tomato', spacingInches: 18,
  spacingOnRecord: 18, cambiumIdentity: '42', illustrationKey: null,
};

describe('lastStartMethod', () => {
  it('defaults to sown when the plant has no plantings', () => {
    expect(lastStartMethod({}, tomato)).toBe('sown');
    expect(lastStartMethod({ b1: [planting('5', '8', 'transplanted')] }, tomato)).toBe('sown');
  });

  it('follows the same plant with the highest numeric id, across beds', () => {
    expect(lastStartMethod({
      b1: [planting('9', '7', 'sown'), planting('12', '7', 'transplanted')],
      b2: [planting('10', '7', 'sown')],
    }, tomato)).toBe('transplanted');
    // Numeric, not string, order: 9 < 10.
    expect(lastStartMethod({
      b1: [planting('9', '7', 'transplanted'), planting('10', '7', 'sown')],
    }, tomato)).toBe('sown');
  });

  it('matches by Cambium identity and skips temp rows', () => {
    expect(lastStartMethod({
      b1: [planting('3', null, 'transplanted', '42'), planting('temp-1', '7', 'sown')],
    }, tomato)).toBe('transplanted');
  });
});

describe('placementFollowUp', () => {
  const free = { tier: 'free' as const, supporterPromptShown: false };

  it('opens the Supporter prompt for an edited date on a free account that has not seen it', () => {
    expect(placementFollowUp({ placed: true, dateEdited: true, ...free })).toBe('supporter');
  });

  it("asks for 'planted' feedback when the date was left on today", () => {
    expect(placementFollowUp({ placed: true, dateEdited: false, ...free })).toBe('feedback');
  });

  it('asks for feedback once the prompt was shown, or for a Supporter or guest', () => {
    expect(placementFollowUp({ placed: true, dateEdited: true, tier: 'free', supporterPromptShown: true })).toBe('feedback');
    expect(placementFollowUp({ placed: true, dateEdited: true, tier: 'supporter', supporterPromptShown: false })).toBe('feedback');
    expect(placementFollowUp({ placed: true, dateEdited: true, tier: undefined, supporterPromptShown: undefined })).toBe('feedback');
  });

  it('does nothing when the placement failed', () => {
    expect(placementFollowUp({ placed: false, dateEdited: true, ...free })).toBeNull();
  });
});
