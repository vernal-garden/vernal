import { defineConfig, devices } from '@playwright/test';

// Two webServer entries because the app is split across two processes in every
// environment (dev: Vite on 5173 + API on 3005; prod: Nginx (outside this repo)
// serving client/dist + API on 3000). Express itself never serves the SPA — see
// tests/e2e/README discrepancy notes. Here Vite's own preview server plays the
// role Nginx plays in production, proxying /api to the API process.
//
// Ports are deliberately NOT 3000/3005/5173 (the normal dev/prod ports): this
// dev machine routinely has other servers already bound there (a normal `npm
// run dev` backend, or an unrelated project entirely), and Playwright's
// reuseExistingServer will silently adopt whatever answers first — including
// the wrong app. reuseExistingServer is also forced off so a stray leftover
// process on these E2E-only ports can never be mistaken for a fresh one.
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:4173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: [
    {
      // Startup time for this process is occasionally very inconsistent on
      // Windows dev machines (near-instant most runs, 60s+ on others with no
      // error output in between — consistent with AV/Defender scanning a
      // freshly-spawned node.exe rather than anything the app is doing).
      // Generous timeout to absorb that; CI runners don't see this pattern.
      command: 'node dist/index.js',
      url: 'http://localhost:3105/health',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'npm run preview --prefix client -- --port 4173 --strictPort',
      url: 'http://localhost:4173',
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
