import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// Config is read from process.env on every call (not at import time) so a
// missing R2 setup only fails the code paths that actually touch storage.
function getClient(): S3Client {
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

  return new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey: secretKey },
  });
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
 * Generate a presigned PUT URL for browser-direct upload.
 * Returns the URL; the caller PUTs the file directly to it.
 * expiresIn is in seconds (default 300 = 5 minutes).
 */
export async function getPresignedUploadUrl(
  key: string,
  contentType: string,
  expiresIn = 300,
): Promise<string> {
  const client = getClient();
  return getSignedUrl(
    client,
    new PutObjectCommand({
      Bucket: BUCKET(),
      Key: key,
      ContentType: contentType,
    }),
    { expiresIn },
  );
}

/**
 * Generate a presigned GET URL for private downloads.
 * Used for data export download_url.
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
