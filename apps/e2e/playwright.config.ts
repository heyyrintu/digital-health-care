import { defineConfig, devices } from '@playwright/test';

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
        JWT_SECRET: 'e2e-only-jwt-secret-0123456789abcdef',
        FIELD_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
        WEB_BASE_URL: WEB_URL,
        OTP_DELIVERY: 'disabled',
        // All browser traffic comes from one address here.
        SIGN_IN_RATE_LIMIT: '100000',
      },
    },
    {
      command: `pnpm --dir ../web exec next start --port ${WEB_PORT}`,
      url: `${WEB_URL}/clinic/login`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { API_BASE_URL: API_URL, NEXT_TELEMETRY_DISABLED: '1' },
    },
  ],
});
