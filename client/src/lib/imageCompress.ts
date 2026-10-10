// Client-side photo compression: decode, downscale so the long edge is at most
// MAX_EDGE px, and re-encode as JPEG. Rejects when the file can't be decoded.

const MAX_EDGE = 2048;
const JPEG_QUALITY = 0.8;

type Decoded = { source: CanvasImageSource; width: number; height: number; release: () => void };

function decodeWithImg(file: File): Promise<Decoded> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({
      source: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      release: () => URL.revokeObjectURL(url),
    });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Image could not be decoded'));
    };
    img.src = url;
  });
}

async function decode(file: File): Promise<Decoded> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
    } catch {
      // Fall through: some browsers reject the options bag or the format.
    }
  }
  return decodeWithImg(file);
}

export async function compressImage(file: File): Promise<Blob> {
  const img = await decode(file);
  try {
    if (!img.width || !img.height) throw new Error('Image could not be decoded');

    const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
    const width = Math.round(img.width * scale);
    const height = Math.round(img.height * scale);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas is not available');
    ctx.drawImage(img.source, 0, 0, width, height);

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        blob => (blob ? resolve(blob) : reject(new Error('Image could not be encoded'))),
        'image/jpeg',
        JPEG_QUALITY,
      );
    });
  } finally {
    img.release();
  }
}
