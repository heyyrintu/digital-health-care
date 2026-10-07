import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration tests need Postgres; they run via `test:integration`.
    exclude: [...configDefaults.exclude, '**/*.int.test.ts'],
  },
});
