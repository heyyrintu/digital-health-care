# Medicine catalogue plan

The repository currently seeds a small **synthetic, illustrative** medicine catalogue.
It is useful for demonstrations, not a validated Indian brand master or a prescribing
reference. Existing clinic medicine search, custom entries and approval workflows are the
starting point for the catalogue work below.

| Stage | Deliverable | Acceptance |
| --- | --- | --- |
| 1. Source | Licensed Indian generic/brand data feed, or an authorised clinic spreadsheet | Written reuse rights and named clinical reviewer; source fields and update cadence agreed |
| 2. Import | Admin-only preview and reviewed publication | Validate ingredient identities, strengths and units, formulation, route, brand/manufacturer, source ID, version and active status; reject invalid rows and flag duplicates |
| 3. Prescribing search | Generic and brand search with strength/form displayed; clinic favourites and custom entries | Clinician can distinguish similar products; local entries stay clinic-scoped; master IDs remain stable across updates |
| 4. Maintenance | Versioned updates, provenance and withdrawal/deactivation handling | Existing prescriptions retain their original medicine snapshot; updates cannot rewrite signed records |
| 5. Clinical facts | Independently sourced, versioned interaction/allergy/dose information | Licensed evidence and clinical approval before enabling any decision support; product catalogue alone does not establish safe doses |

Begin with stage 1 and an import sample reviewed by the clinic. Do not scrape retail
pharmacy listings or generate clinical facts with AI. Do not bundle a paid feed without
permission. The owner must choose/authorise the data source; no purchase is implied by
this plan. Until validated data is loaded, keep synthetic preview records clearly marked.

Mobile, AI providers, cloud prescription signing and ABDM remain outside this increment.

### Source research and inspection — 12 November 2026

The recommended source is NRCeS / C-DAC's **Common Drug Codes for India (CDCI)**.
The owner downloaded the official package; its licence and all seven master files have
been inspected. The licence states CC BY 4.0 and permits implementation products/services
within India, with applicable SNOMED affiliate terms for included International content.
The owner reported submitting the affiliate application on 13 November 2026. Approval
and its evidence are still pending before production publication.

The package has 93,911 brand rows and 10,305 generic rows. Fourteen brand rows need
quarantine for missing/unresolved generic links. All brand regulatory licence statuses
are UNKNOWN, and clinical safety fields are incomplete; neither is proof of approval or
absence of interactions. See [the inspection and source comparison](medicine-data-sources-2026-11-12.md).

Next: confirm applicable licensing, add external-ID/provenance support to the clinical master,
and implement clinician mapping/review before real-data publication. No live medicine import or patient-ABDM integration has occurred.

### Staging implementation — licensing deferred

The owner chose **Check later** for SNOMED affiliate licensing. Real-data publication
remains pending. The first staging increment is implemented using entirely synthetic
fixtures: an offline command validates the seven master tables, quarantines bad links
and duplicate identifiers, retains source IDs/checksums/version, and produces review
artifacts, plus comparison artifacts when `--previous` names a completed stage. That offline increment did not change the database or hosted page.

This increment adds platform-only durable synthetic snapshots, a review screen at
`/platform/medicines`, immutable review decisions, and an active sandbox release with
conflict protection and reactivation of an earlier reviewed release. It displays
candidate links, quarantine rows, provenance and changes from the active sandbox.
Clinic prescribing does not read this sandbox, and platform operators receive no new
permissions on clinical medicine or prescription tables.

See [the staging runbook](../runbooks/medicine-catalogue-staging.md). Stage 2 remains
partially complete: clinical mapping/review, external-ID support in the live medicine
master, licence approval and real-data publication still remain. There is no real-data
publication endpoint. Source hashes establish consistency, not authenticity or licensing;
the synthetic manifest is an operator declaration, not a content classifier.

### Review preparation — clinician worksheet

This increment adds a downloadable, audited synthetic-only CSV worksheet
to the platform review screen. It preserves source provenance and produces one row per
ingredient, with blank fields for a clinician's ingredient, strength, form, route,
regulatory and review decisions. It does not infer clinical mappings, import completed
worksheets, approve clinical facts or publish medicines into prescribing.

Remaining: name the clinical reviewer, confirm licensing, build validated mapping and
clinical sign-off storage, add stable external IDs to the clinical master, then implement
reviewed real-data publication and maintenance. The worksheet is preparation for those
steps, not completion of them.

### Relational catalogue database — 13 November 2026

The catalogue now has a relational source index, populated atomically whenever a synthetic
review snapshot is uploaded. Stable UUIDs are keyed by dataset, source entity kind and the
original text identifier. Release-specific names and brand links cover products, suppliers,
generics, ingredients, forms and routes. A renamed source entry in a later release reuses
the identity without overwriting historical names. Quarantined brands are not indexed.

The migration backfills existing snapshots without changing their bundle, fingerprint,
review decision, revision or active sandbox selection. The platform role can read the index;
only the migration-owner trigger can populate it. Clinic and authentication roles cannot
access it. The index is source provenance, not a validated clinical mapping.

This is the database foundation for the future licensed catalogue. It does not remove the
current synthetic-only upload limit (500 candidates), import the full real CDCI package,
attach licence evidence, map source entities into clinical medicines, or enable prescribing.
Those remaining publication steps still require approval evidence and clinical review.

### Full private import and mapping workflow — 13 November 2026

The owner authorised full real-source ingestion while approval evidence is pending. A
separate full-release import now stores all seven indexed source tables, valid generic
relationships, accepted brands, file provenance and quarantine reports. It uses owner-only
bounded batches and transactional replay/conflict protection; it does not widen the
synthetic sandbox or write clinical medicine tables.

The actual archive was imported into a private persistent local database: 188,578 source
rows, 10,304 linked generics and 93,694 linked brands. Strict validation quarantines 217
brands and one generic; the original files remain available. No real clinical review was
invented or recorded. These numbers supersede the preliminary raw-link candidate estimate.

The platform mapping workspace supports generic/brand/code search, editable ingredient,
strength/unit/denominator, form, route, evidence and named clinician review fields. It
validates exact source ingredient membership, preserves immutable revision history and
rejects conflicting saves. A recorded review is an operator's attestation about an external
clinician review, not independently verified credentials or prescribing approval.

See [the full import and mapping runbook](../runbooks/full-medicine-import.md). Remaining:
deploy the workflow, import into the intended hosted database, verify licence evidence,
complete actual clinician reviews and canonical clinical molecule mapping, and implement
the separately gated publication path and independently reviewed safety facts. The current
software permanently reports prescribing as blocked; no upload or configuration flag can
activate it in this increment.
