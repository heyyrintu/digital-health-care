# Medicine review queue — 15 November 2026

Implemented locally on the medicine prescribing branch. No hosted rollout, source activation,
licence approval or clinical sign-off was performed.

## Changes

- Added review-status filtering to the private platform source workspace: all mappings,
  not started (SQL NULL mapping), saved drafts and clinician review recorded.
- Filters combine with existing generic, brand and source-code search and apply before
  pagination. Unsupported status values return validation errors.
- Load more keeps the last submitted search/status instead of mixing results with an
  edited but unsubmitted form. Opening another release resets the filters.
- Saving a mapping updates/removes its row in the active queue immediately.
- Added English/Hindi labels and documented the workflow. A recorded review remains
  separate from prescribing approval; licensing/publication controls are unchanged.

## Verification

- API/web/contracts/i18n type checks and lint passed; E2E type check passed.
- API and web production builds passed, including a final web build after the save update.
- Medicine import integration suite: 8 passed. Covers untouched → draft → recorded review,
  invalid status rejection, and filtering 40 mixed-state generics before cursor pagination.
- Contracts: 132 passed. Translations: 4 passed.
- Medicine import browser test: 1 passed. Checks empty draft queue, untouched selection,
  saved-row removal, mapping persistence/history and unchanged clinical medicine count.
- Formatting and diff whitespace checks passed.

Verification used disposable local databases and synthetic fixtures. Missing installed
project dependencies and the test browser were restored; the lockfile was unchanged.
The initial browser attempt could not launch because its executable was absent; the
rerun passed after restoration. Real source records were not touched by this increment.
