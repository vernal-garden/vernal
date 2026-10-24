import { afterEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import {
  ImageBusyError,
  ImageRejectedError,
  processPhoto,
  processThumbnail,
  resetImageLimiter,
  withImageSlot,
} from './imageProcessing';

function flat(width: number, height: number) {
  return sharp({ create: { width, height, channels: 3, background: '#4a7' } });
}

afterEach(() => {
  resetImageLimiter();
  vi.useRealTimers();
});

describe('processPhoto', () => {
  it('re-encodes to JPEG and strips EXIF', async () => {
    const jpegWithGps = await flat(64, 48)
      .withExif({ IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '51/1 30/1 0/1' } })
      .jpeg()
      .toBuffer();
    expect((await sharp(jpegWithGps).metadata()).exif).toBeDefined();

    const out = await processPhoto(jpegWithGps);
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.exif).toBeUndefined();
  });

  it('converts PNG and WebP input to JPEG', async () => {
    const png = await flat(32, 32).png().toBuffer();
    const webp = await flat(32, 32).webp().toBuffer();
    expect((await sharp(await processPhoto(png)).metadata()).format).toBe('jpeg');
    expect((await sharp(await processPhoto(webp)).metadata()).format).toBe('jpeg');
  });

  it('downsizes large images to 2048 and does not enlarge small ones', async () => {
    const big = await flat(4000, 3000).jpeg().toBuffer();
    const bigMeta = await sharp(await processPhoto(big)).metadata();
    expect(Math.max(bigMeta.width!, bigMeta.height!)).toBe(2048);

    const small = await flat(100, 80).jpeg().toBuffer();
    const smallMeta = await sharp(await processPhoto(small)).metadata();
    expect(smallMeta.width).toBe(100);
    expect(smallMeta.height).toBe(80);
  });

  it('rejects non-images, truncated JPEGs and oversize images', async () => {
    await expect(processPhoto(Buffer.from('hello, not an image'))).rejects.toBeInstanceOf(ImageRejectedError);

    const jpeg = await flat(400, 300).jpeg().toBuffer();
    await expect(processPhoto(jpeg.subarray(0, 200))).rejects.toBeInstanceOf(ImageRejectedError);

    const huge = await flat(8000, 5100).png().toBuffer();
    await expect(processPhoto(huge)).rejects.toBeInstanceOf(ImageRejectedError);
  });
});

describe('processThumbnail', () => {
  it('drops trailing data', async () => {
    const png = await flat(40, 40).png().toBuffer();
    const out = await processThumbnail(Buffer.concat([png, Buffer.from('TRAILING-DATA')]));
    expect((await sharp(out).metadata()).format).toBe('png');
    expect(out.includes(Buffer.from('TRAILING-DATA'))).toBe(false);
  });

  it('rejects non-PNG input', async () => {
    const jpeg = await flat(40, 40).jpeg().toBuffer();
    await expect(processThumbnail(jpeg)).rejects.toBeInstanceOf(ImageRejectedError);
  });

  it('fits within 1024 px', async () => {
    const png = await flat(3000, 1000).png().toBuffer();
    const meta = await sharp(await processThumbnail(png)).metadata();
    expect(meta.width).toBe(1024);
  });
});

describe('limiter', () => {
  it('rejects a waiter with ImageBusyError after 10 s', async () => {
    vi.useFakeTimers();
    const never = () => new Promise<void>(() => {});
    void withImageSlot(never);
    void withImageSlot(never);

    const third = withImageSlot(async () => 'ran');
    const assertion = expect(third).rejects.toBeInstanceOf(ImageBusyError);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
  });

  it('runs a waiter when a slot frees before the timeout', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    void withImageSlot(() => held);
    void withImageSlot(() => new Promise<void>(() => {}));

    const third = withImageSlot(async () => 'ran');
    await vi.advanceTimersByTimeAsync(5_000);
    release();
    await expect(third).resolves.toBe('ran');
  });
});
