import dotenv from 'dotenv';
import { loadServerConfig } from '../lib/serverConfig';

dotenv.config();

// Suites provoke errors on purpose, and an unset DSN keeps those out of the real Sentry project.
process.env.SENTRY_DSN = '';

// .env may hold real storage keys, and a suite that doesn't mock storage would delete from the real buckets.
// The suites mock the s3 driver, so it stays selected whatever .env says.
process.env.MEDIA_STORAGE = 's3';
process.env.R2_ACCESS_KEY_ID = '';
process.env.R2_SECRET_ACCESS_KEY = '';

// .env may name a real inbox, and suites that don't mock the mailer would send it owner alerts
// (and feedback mail). Suites that test those set their own address. Empty, not deleted:
// src/loadEnv.ts reloads .env when the app is imported, and dotenv only fills unset variables.
process.env.ALERT_EMAIL_TO = '';
process.env.FEEDBACK_NOTIFY_EMAIL = '';
process.env.ALERT_INSTANT_SIGNUPS = '';

// The test config must not depend on the developer's .env; weather-off behavior is tested through setServerConfigForTests.
process.env.VISUAL_CROSSING_API_KEY ||= 'test-key';

// Suites that never import index.ts (unit tests of libs) still need a config.
loadServerConfig();

const testUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.DATABASE_URL;

if (!testUrl) {
  throw new Error(
    'TEST_DATABASE_URL must be set to run tests. ' +
      'Point it at a dedicated throwaway database, NOT the app database. ' +
      'Example: TEST_DATABASE_URL=postgres://user:pass@localhost:5432/vernal_test',
  );
}

if (testUrl === appUrl) {
  throw new Error(
    'TEST_DATABASE_URL must not equal DATABASE_URL. ' +
      'Tests require a dedicated throwaway database separate from the app database. ' +
      'Running tests against the app DB will corrupt real data.',
  );
}
