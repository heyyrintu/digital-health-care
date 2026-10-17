import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Synthetic settings for the throwaway e2e environment only, shared by the Playwright
 * config (which starts the API with them) and the fixtures (which seed through the API's
 * own code with the same key).
 */
export const E2E_FIELD_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

/** Where the API stores signed PDFs and uploaded results in this environment. */
export const E2E_FILE_STORE_DIR = join(tmpdir(), 'dhc-e2e-files');
