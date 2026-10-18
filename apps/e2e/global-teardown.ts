import { rm } from 'node:fs/promises';

/**
 * Deletes this run's file store (env.ts), in the runner process that created it only. A
 * folder given through E2E_FILE_STORE_DIR from outside, or seen by a worker, is left alone.
 */
export default async function globalTeardown() {
  const dir = process.env.E2E_FILE_STORE_DIR;
  if (!dir || process.env.E2E_FILE_STORE_OWNER !== String(process.pid)) return;
  await rm(dir, { recursive: true, force: true });
}
