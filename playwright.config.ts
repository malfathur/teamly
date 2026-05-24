import { defineConfig, devices } from '@playwright/test';

// Dedicated test port + isolated SQLite file so the dev DB is never touched.
const PORT = 3099;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './tests',
  // Single seeded database shared by every spec — run serially so stateful
  // flows (clock toggles, AL balance, WFH weekly limits) never race.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],

  // global-setup wipes test.db and starts the server with test env vars;
  // global-teardown stops it. (We can't use Playwright's `webServer` here:
  // it launches before globalSetup and would lock the DB before the wipe.)
  globalSetup: './tests/global-setup.ts',
  globalTeardown: './tests/global-teardown.ts',

  timeout: 30_000,
  expect: { timeout: 7_000 },

  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    // Clock tab asks for geolocation; granting it keeps the flow deterministic.
    permissions: ['geolocation'],
    geolocation: { latitude: 3.139, longitude: 101.6869 },
    locale: 'en-GB',
  },

  projects: [
    // Logs in all 4 roles and writes their storage states.
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup'],
      testIgnore: /auth\.setup\.ts/,
    },
  ],
});
