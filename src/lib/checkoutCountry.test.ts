import { describe, it, expect } from 'vitest';
import { checkoutAllowed } from './checkoutCountry';

describe('checkoutAllowed', () => {
  it.each(['US', 'PR', 'GU', 'VI', 'AS', 'MP'])('allows %s', (c) => {
    expect(checkoutAllowed(c)).toBe(true);
  });
  it('is case-insensitive', () => {
    expect(checkoutAllowed('pr')).toBe(true);
  });
  it.each(['GB', 'FR', 'CA', '', null, undefined])('refuses %s', (c) => {
    expect(checkoutAllowed(c)).toBe(false);
  });
});
