export const UI_MAX_QUANTITY = 99;

// A sum clamps at UI_MAX_QUANTITY; an existing quantity already above it
// (possible through the API's 1-9999 range) is never reduced.
export function mergedQuantity(existing: number, added: number): number {
  return Math.min(existing + added, Math.max(existing, UI_MAX_QUANTITY));
}
