# Reviewed catalogue to prescribing

This increment adds **owner-controlled publication**, not automatic activation of the private
CDCI import. No actual licence letter, clinician approval or safety approval has been supplied
by this development run. Fabricated evidence is used only in isolated automated tests.

## Required evidence and mapping

1. In **Platform → Imported medicines and mappings**, select a generic and resolve each
   source ingredient to an exact clinical reference molecule using **Find clinical
   ingredient**. Names alone do not establish equivalence. Unknown IDs, mismatched names
   and multiple source ingredients silently mapped to one molecule are rejected.
2. Complete the reviewed strengths, form, route and evidence. Use the reviewing doctor's
   exact profile name and registration number. Recording a review in the editor is an
   operator attestation; it does not independently verify credentials or publish data.
3. Obtain the actual source licence/affiliate approval covering the legal entity, India
   use and the included source licence text. The approval letter is separate from the
   package's `License.txt`; its hash must match the imported release's licence-text hash.
4. Load and independently review the clinical safety dataset. The current synthetic sample
   cannot satisfy this gate. CDCI narrative fields are not converted into interaction,
   pregnancy, renal, maximum-dose or other safety facts by this feature.
5. Obtain clinician review evidence for the exact mapping revision **and the exact selected
   brand snapshots**, including regulatory review of those brands. Generic review cannot
   silently authorize every brand. The reviewing doctor must have an active user and a
   verified doctor profile; registration/council changes invalidate the credential check.

The existing prescribing model represents exact **mg per dose unit or mL**. Publication
converts explicitly reviewed g/microgram quantities only when they fit that model exactly.
It never rounds. IU, percentage and nonnumeric strengths can be reviewed and retained in
the source workspace, but are blocked from this publication path until supported by the
prescribing/safety model. Oversized display text and more than ten ingredients also fail
closed; there is no truncation or ingredient dropping.

## Owner command and private documents

The backend ships `node /app/apps/api/dist/manage-medicine-catalogue.js`; in the repository
use `pnpm --filter @dhc/api medicines:catalogue`. It requires an explicit owner
`DATABASE_URL`, the application's private `FILE_STORE_DIR`, and an existing active
`--operator-email`. It does not load `.env` or print connection credentials.

Documents are supplied as private files (nonempty, at most 5 MiB), retained under a random
private file key and SHA-256 hash. They are not rendered or exposed through a public URL.
An unsuccessful evidence transaction removes its new file. Include retained evidence files
in the normal paired database/file backup and retention policy.

Create owner-reviewed JSON requests privately. Replace every placeholder with an actual
value; the examples are templates, not approvals:

```json
{
  "kind": "licence",
  "datasetKey": "nrces-cdci-flat-files",
  "affiliateReference": "<actual affiliate reference>",
  "licenceTextSha256": "<imported release licence-text SHA-256>",
  "licensee": "<legal licence holder>",
  "territory": "IN",
  "useWithinIndiaConfirmed": true,
  "validFrom": "<actual effective date/time in UTC>",
  "validUntil": null
}
```

Use the actual expiry when applicable; `null` declares no expiry rather than inventing
one. Future-effective, expired and revoked evidence cannot authorize publication.

Safety evidence uses `kind: "safety"`, `databaseVersion`, `doctorProfileId`,
`reviewEvidenceConfirmed: true`, `validFrom` and `validUntil`. Its version must equal the
current non-synthetic `drug_database` version. The human review must cover that dataset's
clinical applicability; renaming demonstration data is not a real safety-data import.

Clinical evidence uses `kind: "clinical"`, `releaseId`, `sourceId` (generic code),
`revision`, `doctorProfileId`, `reviewEvidenceConfirmed: true`,
`brandRegulatoryReviewConfirmed: true`, `brandIds` (1–500 explicitly reviewed codes),
`validFrom` and `validUntil`. The command binds it to the mapping hash and each selected
brand's source hash. This is a human-recorded review, not a cryptographic clinician signature
or independent medical-council verification.

Record each document only after actually reviewing it:

```sh
pnpm --filter @dhc/api medicines:catalogue \
  --action evidence --input /private/approval-request.json \
  --document /private/actual-approval-document \
  --operator-email operator@example.org --execute --confirm-reviewed
```

Record the returned evidence IDs; the document contents are not printed. Evidence fields
are immutable. Revocation is one-way, requires a documented reason and affects future
selection/signing without deleting historical prescriptions:

```sh
pnpm --filter @dhc/api medicines:catalogue \
  --action revoke --evidence-id <actual-evidence-UUID> \
  --reason "<documented reason of at least ten characters>" \
  --operator-email operator@example.org --execute --confirm-reviewed
```

## Preview, publication and cutover

Prepare a publication JSON request with `releaseId`, generic `sourceId`, mapping `revision`,
`licenceId`, `clinicalId`, `safetyId`, `brandIds` and `expectedRevisions`. The latter maps
each selected brand code to its current publication revision, or `null` for a new brand.
Every selected brand must belong to the exact release and generic, and be covered by the
clinical/regulatory evidence. There is no HTTP publication endpoint or platform-role grant
on clinical medicine tables.

```sh
pnpm --filter @dhc/api medicines:catalogue \
  --action publish --input /private/publication-request.json \
  --operator-email operator@example.org
```

This defaults to preview: it checks evidence dates, hashes, scope, credentials, mappings,
clinical identities and current revisions, and returns counts/current IDs without activating
medicines. Source hashes prove consistency, not licensing, clinical validity or authenticity.

The **first** real publication hides unreviewed legacy reference choices from future picking
and signing. It leaves their records and old signed prescriptions intact. Preview reports
the affected count. Rehearse the clinic's accepted initial medicine set before cutover;
execution with affected legacy entries requires `confirmLegacyRetirement: true` in the JSON.
Clinic-owned custom medicines remain clinic-scoped and retain their existing workflow.

After the preview and clinic acceptance, add `--execute --confirm-reviewed` to publish.
Each source dataset/brand keeps a stable medicine UUID across releases. A changed publication
increments its catalogue revision and records an immutable source/mapping/evidence event.
Exact retries do not duplicate medicines or revision history. Other stale updates fail.
The whole operation commits with its audit event or rolls back.

## Expiry, withdrawals and safe prescription history

- Prescription search and the default medicine list exclude expired/revoked/unapproved
  catalogue choices **before** applying result limits. Inactive listings show such entries
  as unavailable, without granting access to private evidence files.
- A picked line carries its catalogue revision. Save/template/sign checks require that
  revision and the approved name, composition, form and route. Dose, frequency, duration,
  quantity and doctor instructions remain editable; the reviewed catalogue route does not.
- Publishing, withdrawing and revoking use a global catalogue transaction lock. Prescription
  save/sign holds its shared counterpart, preventing a mixed publication/facts snapshot.
- Changes to molecules, interactions, condition rules, cross-sensitivities or the safety
  database invalidate existing safety approvals, even if the version string is unchanged.
- Database guards reject stale imported lines and ineligible signing, including a backend
  rollback that omits the new revision field. Starting an amendment may copy an exact
  historical line so the doctor can remove/reselect it; signing still requires current data.
- Deferred database checks bind each published name, composition, route and ingredient
  recipe to its exact review event. Direct changes without a matching publication fail at
  commit; the owner batch can still update the medicine, ingredients and event atomically.
- Existing signed lines, PDFs, signatures and QR history are not rewritten or deleted.

For withdrawal, use `--action withdraw --input <JSON>` with `datasetKey`, `expectedRevisions`
for 1–500 brands and a documented `reason`. Preview is the default; execution needs the
explicit write flags. An identical retry is idempotent. Reactivation requires
`reactivate: true` plus fresh clinician evidence recorded after withdrawal; a release update
cannot silently reactivate a withdrawn brand. Missing rows in a new source release do not
automatically withdraw medicines.

## Verification and current state

The full real catalogue remains in private local storage. No real evidence has been
recorded, no real medicines have been published and nothing has been deployed by this work.
Before real activation: supply and verify the actual documents and independent safety data,
complete clinician/brand review, run the preview, take a paired backup, deploy/test on the
intended host and obtain clinic acceptance of the initial set and its operational limits.
