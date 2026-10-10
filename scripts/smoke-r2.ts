import dotenv from 'dotenv';
dotenv.config();

import crypto from 'crypto';
import { uploadToR2, deleteFromR2, getPresignedUploadUrl } from '../src/lib/r2';

// --presign: check that a presigned PUT enforces its signed Content-Type and
// Content-Length. R2 must accept the exact match and reject both mismatches.
async function presignSmoke(): Promise<void> {
  const key = `seed-photos/smoke/${crypto.randomUUID()}.jpg`;
  const url = await getPresignedUploadUrl(key, 'image/jpeg', 10);
  console.log('Presigned key:', key);

  const cases: { label: string; body: Uint8Array<ArrayBuffer>; contentType: string; expected: number }[] = [
    { label: '10 bytes image/jpeg', body: new Uint8Array(10).fill(1), contentType: 'image/jpeg', expected: 200 },
    { label: '11 bytes image/jpeg', body: new Uint8Array(11).fill(1), contentType: 'image/jpeg', expected: 403 },
    { label: '10 bytes text/html ', body: new Uint8Array(10).fill(1), contentType: 'text/html', expected: 403 },
  ];

  let failed = false;
  try {
    for (const c of cases) {
      const res = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': c.contentType },
        body: c.body,
      });
      const ok = res.status === c.expected;
      if (!ok) failed = true;
      console.log(`PUT ${c.label}: ${res.status} (expected ${c.expected})${ok ? '' : '  <-- UNEXPECTED'}`);
    }
  } finally {
    await deleteFromR2(key);
    console.log('Deleted', key);
  }

  if (failed) process.exit(1);
}

async function main(): Promise<void> {
  if (process.argv.includes('--presign')) {
    await presignSmoke();
    return;
  }

  const key = `smoke-test/${Date.now()}.txt`;
  const body = Buffer.from(`Vernal R2 smoke test ${new Date().toISOString()}\n`);

  const url = await uploadToR2(key, body, 'text/plain');
  console.log('Uploaded key:', key);
  console.log('Public URL:  ', url);

  const res = await fetch(url);
  console.log('GET status:  ', res.status, res.headers.get('content-type'));
  console.log('GET body:    ', (await res.text()).trim());

  if (process.argv.includes('--cleanup')) {
    await deleteFromR2(key);
    console.log('Deleted', key);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});