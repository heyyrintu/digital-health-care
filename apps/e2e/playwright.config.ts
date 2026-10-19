import { defineConfig, devices } from '@playwright/test';
import { E2E_FIELD_ENCRYPTION_KEY, E2E_FILE_STORE_DIR, E2E_JWT_SECRET } from './env';

/**
 * Browser tests against the *built* API and web app (run `pnpm build` first), on their
 * own ports and their own database (E2E_DATABASE_URL), so they never touch dev data.
 */
export const API_PORT = 4300;
export const WEB_PORT = 3300;
export const API_URL = `http://localhost:${API_PORT}/v1`;
export const WEB_URL = `http://localhost:${WEB_PORT}`;

const databaseUrl = process.env.E2E_DATABASE_URL;
if (!databaseUrl) throw new Error('E2E_DATABASE_URL is required for browser tests');

export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',
  // Every test makes its own clinic, so tests can run side by side.
  fullyParallel: true,
  workers: process.env.CI ? 2 : undefined,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 60_000,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: WEB_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: [
    {
      command: 'node ../api/dist/server.js',
      url: `${API_URL}/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        NODE_ENV: 'test',
        DATABASE_URL: databaseUrl,
        API_PORT: String(API_PORT),
        LOG_LEVEL: 'warn',
        // Synthetic secrets for this throwaway environment only.
        JWT_SECRET: E2E_JWT_SECRET,
        FIELD_ENCRYPTION_KEY: E2E_FIELD_ENCRYPTION_KEY,
        WEB_BASE_URL: WEB_URL,
        // Patient sign-in codes go to the API's log, never by SMS; the fixtures set a known
        // code on the challenge instead of reading it (`signInAsPatient`).
        OTP_DELIVERY: 'log',
        // Prescriptions are signed with the test key and stored in a throwaway folder.
        SIGNER: 'test_key',
        FILE_STORE_DIR: E2E_FILE_STORE_DIR,
        // Specs mark no-shows themselves; the automatic sweep would race them.
        NO_SHOW_SWEEP_SECONDS: '0',
        // All browser traffic comes from one address here.
        SIGN_IN_RATE_LIMIT: '100000',
        // The platform console answers the test runner's address (local and CI only; production refuses `*`).
        PLATFORM_ALLOWED_CIDRS: '*',
        // No Redis, whatever the developer's shell has: system health shows the queues as
        // not configured, as in CI.
        REDIS_URL: '',
      },
    },
    {
      command: `pnpm --dir ../web exec next start --port ${WEB_PORT}`,
      url: `${WEB_URL}/clinic/login`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        API_BASE_URL: API_URL,
        NEXT_TELEMETRY_DISABLED: '1',
        // `next start` runs in production, where the portal's consents need both documents.
        // Canonical links and the sitemap on the public pages (required in production).
        PUBLIC_SITE_URL: WEB_URL,
        // Doctors listed by different tests a few seconds apart must all show: keep the
        // public pages' API answers one second, not five minutes (a doctor page still
        // rebuilds with a fresh list; see apps/web/lib/config.ts).
        PUBLIC_API_CACHE_SECONDS: '1',
        // Below 60 seconds only with this test-only flag.
        DHC_E2E: '1',
        PRIVACY_NOTICE_URL: 'https://example.com/privacy',
        TERMS_URL: 'https://example.com/terms',
      },
    },
  ],
});
