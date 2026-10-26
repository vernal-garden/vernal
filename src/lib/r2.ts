import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Upload } from '@aws-sdk/lib-storage';
import type { Readable } from 'stream';

// Config is read from process.env on every call (not at import time) so a
// missing R2 setup only fails the code paths that actually touch storage.
// The client is built once and reused: each one holds its own connection pool.
let cachedClient: S3Client | null = null;

/** Forget the cached client so the next call rebuilds it (used by tests). */
export function resetR2Client(): void {
  cachedClient = null;
}

function getClient(): S3Client {
  if (cachedClient) return cachedClient;

  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET_NAME;

  if (!accountId || !accessKeyId || !secretKey || !bucket) {
    throw new Error(
      'R2 not configured: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, ' +
        'R2_SECRET_ACCESS_KEY, and R2_BUCKET_NAME are required.',
    );
  }

  cachedClient = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey: secretKey },
  });
  return cachedClient;
}

const BUCKET = () => {
  const b = process.env.R2_BUCKET_NAME;
  if (!b) throw new Error('R2_BUCKET_NAME is not set.');
  return b;
};

/**
 * The private bucket that holds data export ZIPs. Exports must never land in
 * R2_BUCKET_NAME: that bucket has public access, which covers every object.
 */
export function exportsBucket(): string {
  const b = process.env.R2_EXPORTS_BUCKET_NAME;
  if (!b) throw new Error('R2_EXPORTS_BUCKET_NAME is not set.');
  if (b === process.env.R2_BUCKET_NAME) {
    throw new Error('R2_EXPORTS_BUCKET_NAME must be a private bucket, not the public R2_BUCKET_NAME.');
  }
  return b;
}

const PUBLIC_BASE = () => {
  const u = process.env.R2_PUBLIC_BASE_URL;
  if (!u) throw new Error('R2_PUBLIC_BASE_URL is not set.');
  return u.replace(/\/$/, '');
};

/**
 * Upload a file to R2 from the server side.
 * Returns the public URL (R2_PUBLIC_BASE_URL/{key}). That URL is only
 * meaningful for the public bucket — it does not resolve for an object
 * uploaded to a private bucket via the `bucket` argument.
 * bucket defaults to R2_BUCKET_NAME.
 */
export async function uploadToR2(
  key: string,
  body: Buffer | Uint8Array,
  contentType: string,
  bucket?: string,
): Promise<string> {
  const client = getClient();
  await client.send(
    new PutObjectCommand({
      Bucket: bucket ?? BUCKET(),
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
  return `${PUBLIC_BASE()}/${key}`;
}

/**
 * Upload a stream of unknown length (multipart once it passes one part).
 * Holds at most one 5 MB part in memory at a time.
 * bucket defaults to R2_BUCKET_NAME.
 */
export async function uploadStreamToR2(
  key: string,
  body: Readable,
  contentType: string,
  bucket?: string,
): Promise<void> {
  const upload = new Upload({
    client: getClient(),
    params: { Bucket: bucket ?? BUCKET(), Key: key, Body: body, ContentType: contentType },
    partSize: 5 * 1024 * 1024,
    queueSize: 1,
  });
  try {
    await upload.done();
  } catch (err) {
    // Best effort: lib-storage already cleans up a failed multipart upload.
    await upload.abort().catch(() => undefined);
    throw err;
  }
}

/**
 * Generate a presigned GET URL for private downloads.
 * Used for data export downloads (GET /api/me/export/download).
 * expiresIn is in seconds (default 604800 = 7 days).
 * bucket defaults to R2_BUCKET_NAME.
 */
export async function getPresignedDownloadUrl(
  key: string,
  expiresIn = 604800,
  bucket?: string,
): Promise<string> {
  const client = getClient();
  return getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: bucket ?? BUCKET(), Key: key }),
    { expiresIn },
  );
}

/**
 * Delete an object from R2.
 * Does not throw if the object does not exist.
 * bucket defaults to R2_BUCKET_NAME.
 */
export async function deleteFromR2(key: string, bucket?: string): Promise<void> {
  const client = getClient();
  await client.send(
    new DeleteObjectCommand({
      Bucket: bucket ?? BUCKET(),
      Key: key,
    }),
  );
}

// Folder paths for each owner of R2 objects. Each ends in '/', so a prefix
// delete for seed 5 can never match seed 50.
export const seedPhotoFolder = (seedId: number | string) => `seed-photos/${seedId}/`;
export const harvestPhotoFolder = (harvestId: number | string) => `harvest-photos/${harvestId}/`;
export const gardenThumbnailFolder = (gardenId: number | string) => `garden-thumbnails/${gardenId}/`;
export const exportFolder = (accountId: number | string) => `exports/${accountId}/`;

// One page at a time through a listing; yields each page's response.
async function* listPages(
  client: S3Client,
  input: { Bucket: string; Prefix: string; Delimiter?: string },
) {
  let token: string | undefined;
  do {
    const page = await client.send(new ListObjectsV2Command({ ...input, ContinuationToken: token }));
    yield page;
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
}

/**
 * Delete every object under a folder prefix (which must end in '/').
 * Listing pages hold at most 1,000 keys, the DeleteObjects limit.
 * Throws if R2 reports any key it could not delete.
 */
export async function deletePrefixFromR2(prefix: string, bucket?: string): Promise<void> {
  if (!prefix.endsWith('/')) throw new Error(`R2 prefix must end with /: ${prefix}`);
  const client = getClient();
  const Bucket = bucket ?? BUCKET();
  for await (const page of listPages(client, { Bucket, Prefix: prefix })) {
    const objects = (page.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
    if (objects.length === 0) continue;
    const result = await client.send(
      new DeleteObjectsCommand({ Bucket, Delete: { Objects: objects, Quiet: true } }),
    );
    if (result.Errors && result.Errors.length > 0) {
      throw new Error(`R2 could not delete ${result.Errors.length} object(s) under ${prefix}`);
    }
  }
}

/** The immediate sub-folders of a prefix, e.g. 'seed-photos/' → ['seed-photos/1/', …]. */
export async function listFolders(prefix: string, bucket?: string): Promise<string[]> {
  const client = getClient();
  const folders: string[] = [];
  for await (const page of listPages(client, { Bucket: bucket ?? BUCKET(), Prefix: prefix, Delimiter: '/' })) {
    for (const p of page.CommonPrefixes ?? []) if (p.Prefix) folders.push(p.Prefix);
  }
  return folders;
}

/** Every key under a prefix. */
export async function listKeys(prefix: string, bucket?: string): Promise<string[]> {
  const client = getClient();
  const keys: string[] = [];
  for await (const page of listPages(client, { Bucket: bucket ?? BUCKET(), Prefix: prefix })) {
    for (const o of page.Contents ?? []) if (o.Key) keys.push(o.Key);
  }
  return keys;
}

/** Every object under a prefix, with its last-modified time. */
export async function listObjects(
  prefix: string,
  bucket?: string,
): Promise<{ key: string; lastModified: Date | null }[]> {
  const client = getClient();
  const objects: { key: string; lastModified: Date | null }[] = [];
  for await (const page of listPages(client, { Bucket: bucket ?? BUCKET(), Prefix: prefix })) {
    for (const o of page.Contents ?? []) {
      if (o.Key) objects.push({ key: o.Key, lastModified: o.LastModified ?? null });
    }
  }
  return objects;
}

// True for the plain Errors these helpers throw when R2 env vars are missing.
export function isR2ConfigError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.message.startsWith('R2 not configured') || err.message.endsWith('is not set.'))
  );
}

// The R2 key of a thumbnail this garden owns, or null for any other URL
// (including one stored under another garden's prefix).
export function ownedThumbnailKey(url: string | null, gardenId: string): string | null {
  const base = process.env.R2_PUBLIC_BASE_URL?.replace(/\/$/, '');
  if (!url || !base) return null;
  const prefix = `${base}/garden-thumbnails/${gardenId}/`;
  return url.startsWith(prefix) ? url.slice(base.length + 1) : null;
}
