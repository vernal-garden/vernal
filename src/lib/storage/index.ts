import type { Response } from 'express';
import type { Readable } from 'stream';
import { ConfigError, getServerConfig } from '../serverConfig';
import * as s3 from './s3';
import { localDriver } from './local';

// Where photos, thumbnails and export ZIPs live. MEDIA_STORAGE picks the
// driver: 's3' (the default: Cloudflare R2 or any S3-compatible service) or
// 'local' (files under MEDIA_DIR). Callers name an area, never a bucket.

/** 'media' holds photos and thumbnails; 'exports' holds data export ZIPs. */
export type Area = 'media' | 'exports';

export interface StorageDriver {
  put(area: Area, key: string, body: Buffer | Uint8Array, contentType: string): Promise<void>;
  putStream(area: Area, key: string, body: Readable, contentType: string): Promise<void>;
  /** null when the object is missing. */
  getStream(area: Area, key: string): Promise<Readable | null>;
  /** A missing object is fine. */
  remove(area: Area, key: string): Promise<void>;
  /** prefix must end in '/'. */
  removePrefix(area: Area, prefix: string): Promise<void>;
  /** The immediate sub-folders of a prefix, e.g. 'seed-photos/' → ['seed-photos/1/', …]. */
  listFolders(area: Area, prefix: string): Promise<string[]>;
  listKeys(area: Area, prefix: string): Promise<string[]>;
  listObjects(area: Area, prefix: string): Promise<{ key: string; lastModified: Date | null }[]>;
  /** Answers GET /api/media/<key> for a caller already known to own the key. */
  sendMedia(res: Response, key: string, now?: Date): Promise<void>;
  sendDownload(res: Response, area: Area, key: string, filename: string, ttlSeconds: number): Promise<void>;
  /** Startup check; throws a ConfigError when the storage cannot be used. */
  checkReady(): Promise<void>;
}

const HOUR_MS = 60 * 60 * 1000;

// The s3 driver calls through the module namespace (not local bindings) so
// test suites can vi.mock('./s3') and see every call.
// undefined means R2_BUCKET_NAME, the photo bucket.
const bucketFor = (area: Area): string | undefined => (area === 'exports' ? s3.exportsBucket() : undefined);

const s3Driver: StorageDriver = {
  async put(area, key, body, contentType) {
    await s3.uploadToR2(key, body, contentType, bucketFor(area));
  },
  async putStream(area, key, body, contentType) {
    await s3.uploadStreamToR2(key, body, contentType, bucketFor(area));
  },
  async getStream(area, key) {
    return s3.getMediaObject(key, bucketFor(area));
  },
  async remove(area, key) {
    await s3.deleteFromR2(key, bucketFor(area));
  },
  async removePrefix(area, prefix) {
    await s3.deletePrefixFromR2(prefix, bucketFor(area));
  },
  async listFolders(area, prefix) {
    return s3.listFolders(prefix, bucketFor(area));
  },
  async listKeys(area, prefix) {
    return s3.listKeys(prefix, bucketFor(area));
  },
  async listObjects(area, prefix) {
    return s3.listObjects(prefix, bucketFor(area));
  },
  // Redirects to a signed R2 link.
  async sendMedia(res, key, now = new Date()) {
    const location = await s3.getMediaRedirectUrl(key, now);
    // The signed URL changes on the hour, so the redirect is cached until then.
    const untilNextHour = Math.ceil((HOUR_MS - (now.getTime() % HOUR_MS)) / 1000);
    res.set('Cache-Control', `private, max-age=${Math.max(60, untilNextHour)}`);
    res.redirect(302, location);
  },
  // Redirects to a short-lived signed link. filename is not used: the ZIP's
  // key already names it, and signing it in would change today's links.
  async sendDownload(res, area, key, _filename, ttlSeconds) {
    const link = await s3.getPresignedDownloadUrl(key, ttlSeconds, bucketFor(area));
    res.redirect(302, link);
  },
  // Missing R2 settings fail each call instead (503s from the routes), so a
  // server without photo storage still starts.
  async checkReady() {},
};

export function storage(): StorageDriver {
  return getServerConfig().media === 'local' ? localDriver : s3Driver;
}

/** True for the errors either driver throws when its settings are missing or unusable. */
export function isStorageConfigError(err: unknown): boolean {
  return err instanceof ConfigError || s3.isR2ConfigError(err);
}
