// Folder paths for each owner of stored objects. Each ends in '/', so a prefix
// delete for seed 5 can never match seed 50.
export const seedPhotoFolder = (seedId: number | string) => `seed-photos/${seedId}/`;
export const harvestPhotoFolder = (harvestId: number | string) => `harvest-photos/${harvestId}/`;
export const gardenThumbnailFolder = (gardenId: number | string) => `garden-thumbnails/${gardenId}/`;
export const exportFolder = (accountId: number | string) => `exports/${accountId}/`;
