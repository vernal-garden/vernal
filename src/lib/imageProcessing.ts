import sharp from 'sharp';

export const MAX_INPUT_PIXELS = 40_000_000;
export const PHOTO_MAX_EDGE = 2048;
export const PHOTO_JPEG_QUALITY = 80;
export const THUMBNAIL_MAX_EDGE = 1024;
export const MAX_CONCURRENT = 2;
export const MAX_WAIT_MS = 10_000;

export class ImageRejectedError extends Error {
  constructor(message = "That file isn't a supported image.") {
    super(message);
    this.name = 'ImageRejectedError';
  }
}

export class ImageBusyError extends Error {
  constructor(message = 'Busy, try again.') {
    super(message);
    this.name = 'ImageBusyError';
  }
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isJpeg(b: Buffer): boolean {
  return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}

function isPng(b: Buffer): boolean {
  return b.length >= PNG_SIGNATURE.length && b.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
}

function isWebp(b: Buffer): boolean {
  return (
    b.length >= 12 &&
    b.toString('latin1', 0, 4) === 'RIFF' &&
    b.toString('latin1', 8, 12) === 'WEBP'
  );
}

// --- Concurrency limiter -------------------------------------------------

interface Waiter {
  resolve: () => void;
  timer: ReturnType<typeof setTimeout>;
}

let active = 0;
let waiters: Waiter[] = [];

function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const waiter: Waiter = {
      resolve,
      timer: setTimeout(() => {
        waiters = waiters.filter((w) => w !== waiter);
        reject(new ImageBusyError());
      }, MAX_WAIT_MS),
    };
    waiters.push(waiter);
  });
}

function release(): void {
  const next = waiters.shift();
  if (next) {
    // Hand the slot straight to the next waiter; `active` stays the same.
    clearTimeout(next.timer);
    next.resolve();
  } else if (active > 0) {
    active--;
  }
}

export async function withImageSlot<T>(fn: () => Promise<T>): Promise<T> {
  await acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

export function resetImageLimiter(): void {
  for (const w of waiters) clearTimeout(w.timer);
  waiters = [];
  active = 0;
}

// --- Processors ----------------------------------------------------------

async function runSharp(build: () => Promise<Buffer>): Promise<Buffer> {
  return withImageSlot(async () => {
    try {
      return await build();
    } catch {
      throw new ImageRejectedError();
    }
  });
}

export async function processPhoto(input: Buffer): Promise<Buffer> {
  if (!isJpeg(input) && !isPng(input) && !isWebp(input)) throw new ImageRejectedError();
  return runSharp(() =>
    sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' })
      .rotate()
      .resize({ width: PHOTO_MAX_EDGE, height: PHOTO_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: PHOTO_JPEG_QUALITY })
      .toBuffer(),
  );
}

export async function processThumbnail(input: Buffer): Promise<Buffer> {
  if (!isPng(input)) throw new ImageRejectedError();
  return runSharp(() =>
    sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' })
      .resize({ width: THUMBNAIL_MAX_EDGE, height: THUMBNAIL_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer(),
  );
}
