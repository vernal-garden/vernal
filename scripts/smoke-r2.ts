import dotenv from 'dotenv';
dotenv.config();

import { uploadToR2, deleteFromR2 } from '../src/lib/r2';

async function main(): Promise<void> {
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