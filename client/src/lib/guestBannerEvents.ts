// Window event dispatched after a planting is successfully placed so the guest
// save banner can re-check whether the garden now has anything worth saving.
export const PLANTING_PLACED_EVENT = 'vernal:planting-placed';

export function notifyPlantingPlaced(): void {
  window.dispatchEvent(new CustomEvent(PLANTING_PLACED_EVENT));
}
