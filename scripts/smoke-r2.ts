import dotenv from 'dotenv';
dotenv.config();

import { uploadToR2, getMediaObject, deleteFromR2 } from '../src/lib/storage/s3';

// S3 only (MEDIA_STORAGE=s3, the default): uploads a small object to
// R2_BUCKET_NAME through the s3 driver's code, reads it back, and with
// --cleanup deletes it. Uploads always go through the server, so there is no
// presigned-upload check. A MEDIA_STORAGE=local server has nothing to smoke-test
// here: its startup check already writes and deletes a file in MEDIA_DIR.

async function main(): Promise<void> {
  const key = `smoke-test/${Date.now()}.txt`;
  const text = `Vernal R2 smoke test ${new Date().toISOString()}`;

  await uploadToR2(key, Buffer.from(`${text}\n`), 'text/plain');
  console.log('Uploaded key:', key);

  const body = await getMediaObject(key);
  if (!body) throw new Error(`Uploaded ${key} but could not read it back`);
  let read = '';
  for await (const chunk of body) read += (chunk as Buffer).toString();
  const ok = read.trim() === text;
  console.log('GET body:    ', read.trim(), ok ? '' : '  <-- UNEXPECTED');

  if (process.argv.includes('--cleanup')) {
    await deleteFromR2(key);
    console.log('Deleted', key);
  }

  if (!ok) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
