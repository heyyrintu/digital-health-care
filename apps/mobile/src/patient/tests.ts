/**
 * The Patient app's own part of the Tests screen. Its logic (when Upload result shows, the
 * file checks and every refusal's wording, result names) is shared with the web portal in
 * `@dhc/api-client` (`patient-tests.ts`).
 */

/** The cache folder the Patient app keeps opened test results in; emptied on sign-out. */
export const RESULT_FOLDER = 'test-results';
