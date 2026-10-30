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

  // S3_ENDPOINT points at any S3-compatible service (MinIO, Garage, …) in
  // place of Cloudflare R2; R2_ACCOUNT_ID is then not needed.
  const endpoint = process.env.S3_ENDPOINT?.trim() || undefined;
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET_NAME;

  if ((!endpoint && !accountId) || !accessKeyId || !secretKey || !bucket) {
    throw new Error(
      'R2 not configured: R2_ACCOUNT_ID (or S3_ENDPOINT), R2_ACCESS_KEY_ID, ' +
        'R2_SECRET_ACCESS_KEY, and R2_BUCKET_NAME are required.',
    );
  }

  cachedClient = new S3Client({
    region: 'auto',
    endpoint: endpoint ?? `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey: secretKey },
    // Self-hosted S3 services rarely have per-bucket DNS names.
    ...(endpoint ? { forcePathStyle: true } : {}),
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
 * R2_BUCKET_NAME: that bucket holds user photos and is served only through /api/media.
 */
export function exportsBucket(): string {
  const b = process.env.R2_EXPORTS_BUCKET_NAME;
  if (!b) throw new Error('R2_EXPORTS_BUCKET_NAME is not set.');
  if (b === process.env.R2_BUCKET_NAME) {
    throw new Error('R2_EXPORTS_BUCKET_NAME must be a private bucket, not the public R2_BUCKET_NAME.');
  }
  return b;
}

/**
 * Upload a file to R2 from the server side.
 * bucket defaults to R2_BUCKET_NAME.
 */
export async function uploadToR2(
  key: string,
  body: Buffer | Uint8Array,
  contentType: string,
  bucket?: string,
): Promise<void> {
  const client = getClient();
  await client.send(
    new PutObjectCommand({
      Bucket: bucket ?? BUCKET(),
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
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

const HOUR_MS = 60 * 60 * 1000;

/**
 * Signed GET for a photo or thumbnail, served by GET /api/media/*. Signed as of
 * the start of the current hour and valid for two, so every request in one
 * hour gets the same URL (the browser can cache it) and a cached redirect
 * always has at least an hour of validity left.
 */
export async function getMediaRedirectUrl(key: string, now = new Date()): Promise<string> {
  const signingDate = new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS);
  return getSignedUrl(
    getClient(),
    new GetObjectCommand({ Bucket: BUCKET(), Key: key, ResponseCacheControl: 'private, max-age=3600' }),
    { expiresIn: 7200, signingDate },
  );
}

/**
 * A photo's bytes as a stream, or null when the object does not exist.
 * bucket defaults to R2_BUCKET_NAME.
 */
export async function getMediaObject(key: string, bucket?: string): Promise<Readable | null> {
  try {
    const res = await getClient().send(new GetObjectCommand({ Bucket: bucket ?? BUCKET(), Key: key }));
    return res.Body as Readable;
  } catch (err) {
    if (err instanceof Error && err.name === 'NoSuchKey') return null;
    throw err;
  }
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
