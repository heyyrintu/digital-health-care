import { defineConfig } from '@playwright/test';
import main from './playwright.config';

if (new URL(process.env.E2E_DATABASE_URL!).pathname !== '/dhc_catalogue_e2e')
  throw new Error(
    'Catalogue cutover tests require the separate disposable dhc_catalogue_e2e database.',
  );

export default defineConfig({
  ...main,
  testIgnore: [],
  testMatch: '**/medicine-publication.catalogue.spec.ts',
  fullyParallel: false,
  workers: 1,
});
