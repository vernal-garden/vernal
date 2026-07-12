import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      exclude: ['src/index.ts', 'src/types/**', 'dist/**'],
    },
    testTimeout: 15_000, // allow time for real DB queries in later phases
    // Every suite truncates shared tables (accounts, guest_sessions, ...) in the
    // same TEST_DATABASE_URL. Running files in parallel causes real deadlocks
    // and cross-suite data wipes; force one file at a time.
    fileParallelism: false,
  },
});
