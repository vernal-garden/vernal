import { describe, it, expect } from 'vitest';
import { degreesToCompass } from './compass';

describe('degreesToCompass', () => {
  it('maps 0 degrees to N', () => {
    expect(degreesToCompass(0)).toBe('N');
  });

  it('maps 90 degrees to E', () => {
    expect(degreesToCompass(90)).toBe('E');
  });

  it('maps 180 degrees to S', () => {
    expect(degreesToCompass(180)).toBe('S');
  });

  it('maps 270 degrees to W', () => {
    expect(degreesToCompass(270)).toBe('W');
  });

  it('maps 22.5 degrees to NNE', () => {
    expect(degreesToCompass(22.5)).toBe('NNE');
  });

  it('wraps 360 degrees to N', () => {
    expect(degreesToCompass(360)).toBe('N');
  });

  it('wraps values slightly above 348.75 (N boundary) to N', () => {
    expect(degreesToCompass(350)).toBe('N');
  });

  it('returns null for null input', () => {
    expect(degreesToCompass(null)).toBeNull();
  });
});
