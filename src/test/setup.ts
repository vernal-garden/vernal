import dotenv from 'dotenv';

dotenv.config();

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
