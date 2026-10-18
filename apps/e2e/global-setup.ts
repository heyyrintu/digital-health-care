import { createDb, seedSampleMedicines } from '@dhc/db';
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Checks the apps are built, empties the web app's fetch cache, brings the e2e database up
 * to date and loads the sample medicine master (shared by every test's clinic).
 */
export default async function globalSetup() {
  const url = process.env.E2E_DATABASE_URL!;
  const root = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));

  for (const build of ['api/dist/server.js', 'web/.next/BUILD_ID']) {
    if (!existsSync(root(build))) {
      throw new Error(`Missing ${build}. Run \`pnpm build\` before the browser tests.`);
    }
  }

  // Next keeps the public pages' API answers on disk between runs (`next build` keeps
  // .next/cache too). An earlier run's directory or doctor list would be served once more
  // before it refreshes, without this run's doctors, so start without them.
  rmSync(root('web/.next/cache/fetch-cache'), { recursive: true, force: true });

  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: fileURLToPath(new URL('../../packages/db', import.meta.url)),
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
  });

  const db = createDb(url);
  try {
    await seedSampleMedicines(db);
  } finally {
    await db.$disconnect();
  }
}
