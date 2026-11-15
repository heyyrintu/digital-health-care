# Full source import and mapping workflow — 13 November 2026

Code and data verification were local. Nothing in this run deployed code or imported data
into the hosted database. Real source content is stored only under ignored, Docker-excluded
`.data/medicine-import-private/`; no real records are committed as fixtures.

## Actual source import

Official downloaded archive SHA-256:
`aebd30ac95d73accf573c86fd4dae1dc90eff03ae0fbcd312bc761011e88270a`.
The included licence was read, retained privately and hashed. Affiliate approval is still
pending; the owner explicitly authorised private source ingestion while awaiting its letter.

The owner-only importer committed one release in a separate persistent PostgreSQL database:

| Source table | Indexed rows |
| --- | ---: |
| Brand | 93,910 |
| Generic | 10,305 |
| Product | 72,284 |
| Supplier | 8,213 |
| Substance | 3,283 |
| Form | 423 |
| Route | 160 |
| **Total** | **188,578** |

Linked candidates: **93,694 brands, 10,304 generics**. There are 218 issue records:
217 quarantined brands and one generic. One malformed brand row cannot be indexed;
13 brands have unresolved generic links; a generic with a repeated route identifier
quarantines another 203 brands. Raw indexed source rows and the original archive are
retained; no source data was silently repaired.

The production-built CLI replayed the same real release idempotently with `created: false`.
The replay took 2.35 seconds with approximately 560 MiB maximum resident memory on this Mac;
this measures the parser/replay, not a production VPS import guarantee. Actual cold ingestion
was performed earlier using the same importer. Clinical medicine and prescription counts
in this isolated database remain zero. All real generic mappings remain unreviewed.

## Code validation

- Database and API type checks; API/web lint; API and web production builds passed.
- Production import command is bundled with the backend; its built `--help` command passed.
- Focused staging/review unit tests: 37 passed.
- Medicine import/review database integration tests: 21 passed against disposable PostgreSQL.
  Covers all-source ingestion, unreferenced generic retention, quarantine, replay/conflicting
  bytes, complete rollback, role isolation, brand/code search, pagination, exact ingredient
  membership, strength/review validation, mapping revisions and concurrent-save conflicts.
- Contract tests: 132 passed, including non-mass units and percentage basis validation.
- Translation tests: 4 passed. E2E type check passed.
- Built-app browser tests: 2 passed. Synthetic fixture only: source release selection,
  mapping draft, clinician review record, persistence/history, attestation reset after
  edits, percentage denominator handling and the existing sandbox/worksheet workflow.

Browser evidence: `/private/tmp/dhc-medicine-mapping-preview.png` (fabricated data only).

## Limits and remaining approval work

The workflow records clinician-entered mappings and an operator attestation; it does not
verify credentials, digitally sign the review or approve prescribing. No AI-generated
strengths or safety facts were inserted. Source ingredient names are editable proposals;
numeric strengths/routes/forms must be provided explicitly.

Licence evidence verification, actual clinician review and canonical clinical molecule
resolution/publication remain required. The API always reports clinical publication as
blocked and exposes no activation route. The hosted deployment and hosted import have not
been performed. Source data will need the owner command against its intended database after
the code is deployed; the private staging cluster must never replace a production database.
