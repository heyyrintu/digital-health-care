import { chmodSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Synthetic settings for the throwaway e2e environment only, shared by the Playwright
 * config (which starts the API with them) and the fixtures (which seed through the API's
 * own code with the same key).
 */
export const E2E_FIELD_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

/**
 * Where the API stores signed PDFs and uploaded results in this run: a new private folder
 * (0700) under the system temp dir. The runner makes it when it loads the config; its
 * workers, started from it, inherit the path through the environment and reuse it.
 */
function fileStoreDir(): string {
  const existing = process.env.E2E_FILE_STORE_DIR;
  if (existing) return existing;
  const dir = mkdtempSync(join(tmpdir(), 'dhc-e2e-files-'));
  chmodSync(dir, 0o700);
  process.env.E2E_FILE_STORE_DIR = dir;
  return dir;
}
export const E2E_FILE_STORE_DIR = fileStoreDir();
