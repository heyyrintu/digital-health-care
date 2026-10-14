import { defineConfig } from 'vitest/config';

/** Plain TypeScript logic only (session, locale); screens are checked on device. */
export default defineConfig({
  test: { include: ['src/**/*.test.ts'] },
});
