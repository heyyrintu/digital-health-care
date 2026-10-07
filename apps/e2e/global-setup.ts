import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Checks the apps are built and brings the e2e database up to date. */
export default function globalSetup() {
  const url = process.env.E2E_DATABASE_URL!;
  const root = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));

  for (const build of ['api/dist/server.js', 'web/.next/BUILD_ID']) {
    if (!existsSync(root(build))) {
      throw new Error(`Missing ${build}. Run \`pnpm build\` before the browser tests.`);
    }
  }

  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: fileURLToPath(new URL('../../packages/db', import.meta.url)),
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
  });
}
