# Reviewed medicine publication and prescribing — 13 November 2026

Local implementation and isolated verification only. No GitHub release, hosted deployment,
actual licence approval, real clinician sign-off or real medicine activation was performed.

## Implemented

- Exact clinical molecule selection from a narrow platform reference lookup. Drafts can
  retain unresolved targets; publication requires resolved identities, exact source
  ingredient membership and current reference names.
- Owner-only private documentary evidence for source licensing, verified clinician review
  and an independent non-synthetic safety dataset. Clinical/regulatory evidence is bound
  to the exact mapping revision and explicitly selected brand source hashes.
- Preview-first publication, immutable provenance events, stable medicine IDs across source
  releases, conflict/lost-response recovery, withdrawal and guarded reactivation. There is
  no HTTP clinical publication grant. Initial retirement of unreviewed legacy reference
  choices requires explicit cutover confirmation.
- Approval-aware search, prescription/template revision checks and signing revalidation.
  A shared catalogue lock excludes publication/revocation while the prescription transaction
  runs. DB guards reject an older client/backend that omits the revision.
- Existing signed snapshots/PDFs remain intact. Exact historical amendment copies can be
  opened for correction but cannot be signed as current without valid catalogue choices.
- Safety-fact mutations invalidate the old safety approval, including changes made under
  an unchanged version label. Evidence fields are immutable apart from one-way revocation.

## Verification

- Prisma generation and database/API/web/E2E/shared-package type checks passed.
- API/web/contracts/database/i18n lint passed. API and web production builds passed.
- Built owner catalogue command `--help` passed without credentials or database access.
- Six relevant integration files passed **75 tests** with the final migrations, including
  14 publication cases. This is scoped medicine/prescribing coverage, not a whole-project
  integration run. Direct name/recipe changes without a matching review event are rejected.
  Coverage includes preview/no activation, exact canonical ingredients, evidence scope and
  expiry, source/document mismatch, stable IDs/revisions, replay, withdrawal/reactivation,
  changed facts, old clients, signed-PDF retention and historical amendments.
- Contract tests: 132 passed. Translation tests: 4 passed.
- Shared-catalogue browser regression: 6 passed across import/review, prescription builder,
  templates, signing, amendments, voiding, PDF/QR and test-order workflows.
- Isolated catalogue browser test: 1 passed. A clinician selected a canonical molecule in
  the form, recorded a fabricated mapping, then owner tooling recorded fabricated evidence
  and published the test source. The doctor selected its versioned medicine, saved and
  signed it, and retained PDF access after approval revocation. All data/documents/facts
  in this test are explicitly fabricated, not actual medical approvals.
- Catalogue activation runs in a dedicated `dhc_catalogue_e2e` database; main browser tests
  exclude it. CI runs it separately so global reference cutover cannot contaminate the
  other tests. The CI workflow change was prepared locally; remote CI has not run yet.

## Preserved real source import

Reopened the existing persistent private database without reinitialising it and applied
the new schema (64 migrations total). Corrected its ignored local restart helper to detect
an existing cluster. A read-only check confirmed:

| Measure | Count |
| --- | ---: |
| Indexed source rows | 188,578 |
| Generic candidates | 10,304 |
| Brand candidates | 93,694 |
| Approval records | 0 |
| Published source medicines | 0 |
| Clinical medicines | 0 |
| Prescriptions | 0 |

These are **private local database** counts, not hosted counts. Real source data remains
under ignored/Docker-excluded `.data/medicine-import-private/`; no real source records or
approval documents are committed to the repository.

## Remaining requirements and limits

Actual source licensing, clinician/brand regulatory review, independent safety facts and
clinic acceptance remain required. The exact-mass engine representation supports mg per
unit/mL; g/microgram conversion must be exact in its precision/range. IU, percentages,
nonnumeric strengths and lossy conversions remain blocked at publication. Display/ingredient
limits fail closed. No medical facts or approvals are generated to bypass these gates.

See [the publication runbook](../runbooks/medicine-prescribing-publication.md) before any
real owner operation. Hosted rollout, paired backups and pilot cutover have not occurred.
