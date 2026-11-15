# Medicine catalogue database — 13 November 2026

Local verification only; this migration has not been deployed by this work.

Implemented a relational index of accepted synthetic source records. Stable identities
are namespaced by dataset and entity kind; names and brand relationships belong to an
immutable snapshot. The upload trigger populates the index in the same transaction.
Existing snapshots are backfilled by the migration.

Validation passed:

- Prisma client generation; database and API type checks; API lint and production build.
- 13 medicine review integration tests on a disposable PostgreSQL database, including
  all seven entity kinds, exact long text IDs, quarantine exclusion, unchanged clinical
  tables, release renames, dataset isolation, upload replay, role restrictions, invalid
  identifier rollback and historical snapshot backfill.
- Maximum accepted snapshot: 500 brands, 506 distinct source identities and 3,000 links.
- Concurrent releases share stable identities without duplicating release rows. Identical
  codes in different entity kinds remain distinct.
- Backfill simulation recreated the migration around an existing reviewed and active
  synthetic snapshot, preserving its bundle, revision, review note and sandbox selection.
- Built-app browser test passed: upload, source inspection, worksheet download, review
  and sandbox publication continued to work after the first 61 migrations, through `20261113090000_medicine_catalogue_index`.
  Later full-schema checks are recorded in the publication and review-queue QA reports.

The owner reports that the affiliate licence application is submitted; approval evidence
is pending. No real CDCI data was imported or activated. The current upload remains bounded
to 500 synthetic candidates. Full-release import, approval-evidence handling, validated
clinical mappings and clinical publication remain future work, as listed in the product plan.


Subsequent increments implemented a separate full private import and gated publication
path. The private local import contains 188,578 real source rows; the synthetic upload's
500-candidate limit still applies only to the sandbox. Hosted rollout, actual licence and
clinical review evidence, safety data and real medicine activation remain separate steps.
