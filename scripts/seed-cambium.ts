import { execSync } from 'child_process';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const seedFile = path.resolve(__dirname, '../seeds/cambium-starter.sql');
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

console.log('Seeding Cambium starter data...');
execSync(`psql "${databaseUrl}" -f "${seedFile}"`, { stdio: 'inherit' });
console.log('Done.');
