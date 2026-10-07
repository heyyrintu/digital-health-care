import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['**/*.int.test.ts'],
    globalSetup: ['./test/global-setup.ts'],
    // Files share one database and truncate it between tests.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
