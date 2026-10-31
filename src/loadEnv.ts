// Side-effect module: load the project's .env by explicit path rather than
// process.cwd(), and without 'dotenv/config' (which reads DOTENV_CONFIG_* from
// the environment). __dirname is one level below the repo root both under tsx
// (src/) and after tsc (dist/). override stays false on purpose, so values
// already in the environment (tests, CI, pm2 ecosystem) still win.
import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });
