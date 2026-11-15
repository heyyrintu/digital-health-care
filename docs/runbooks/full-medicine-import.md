# Full medicine source import and clinical mappings

This is a private source catalogue and review workspace. It is separate from the synthetic
sandbox and the prescribing master. It does not write `medicines`, `drug_molecules`,
`medicine_ingredients`, safety rules or prescriptions. Release responses report licence status per release: matching active licence evidence
changes it to recorded. Clinical publication still needs separate owner approval; there is
no HTTP activation endpoint.

## Source package and owner command

Use the official NRCeS/C-DAC CDCI flat-files package. Retain `License.txt`, `README.txt`,
the original archive and all seven master files privately. Its CC BY terms and applicable
SNOMED affiliate terms still apply; application submission is not licence approval.
Do not commit source content, put it in the container image or serve it publicly.
Both `.gitignore` and `.dockerignore` exclude `.data`.

Extract only the expected files into a private directory (0700, files 0600). Add this
`manifest.json`; use the actual source release identifier if supplied, otherwise use an
archive-derived version and do not infer a publication date:

```json
{
  "format": "cdci-flat-files/v1",
  "dataKind": "real",
  "datasetKey": "nrces-cdci-flat-files",
  "version": "archive-<first 16 characters of archive SHA-256>"
}
```

Apply migrations and generate Prisma before importing. The import command requires an
explicit owner `DATABASE_URL` and an existing active platform operator. It does not load
`.env` automatically. Keep connection credentials in the execution environment, out of
command arguments and logs. From the repository, run:

```sh
pnpm --filter @dhc/api medicines:import \
  --input /private/path/to/cdci-files \
  --archive /private/path/to/original-package.zip \
  --operator-email operator@example.org \
  --package-sha256 <actual-archive-SHA-256> \
  --acknowledge-pending-licence
```

The backend image also ships the command as
`node /app/apps/api/dist/import-medicines.js` with the same arguments. Mount/copy the private
input directory into the container before running it. The existing owner connection must
be available; do not use the restricted platform SQL role for ingestion. Run a single import
job at a time on a small VPS; avoid overlapping it with a build.

The command reads the private `--archive` file and verifies its SHA-256 against
`--package-sha256` before database work. The operator must extract the input directory from
that same archive; each imported file also has its own recorded checksum. These hashes demonstrate byte consistency, not authenticity or
permission. The command hashes every master file and the included licence text itself.

## Validation and storage

- Files must be regular UTF-8 files, not symlinks/devices. Each master is limited to
  32 MiB, the package to 64 MiB and each table to 200,000 rows. Expanded real candidates
  have a 256 MiB conservative serialization budget; synthetic staging retains 64 MiB.
- All indexed rows from the seven tables are retained, including generics and substances
  not referenced by an accepted brand. Original source text fields, including narrative
  clinical information, are stored as unreviewed source assertions, never safety rules.
- Invalid identifiers, duplicate identities, malformed columns and broken/duplicated
  references are reported. Invalid brands do not become brand candidates. The original
  archive remains the source of malformed rows that cannot be indexed.
- Valid generic relationships are stored once per release. Accepted brands have a foreign
  key to that release's generic. Source identifiers remain text, preserving every digit.
- Ingestion uses batches of 250 in one owner transaction (five-minute limit). Failure
  rolls back the entire release and audit record. The same dataset/version/bytes replay
  idempotently; changed bytes require a new version. No automatic withdrawal or clinical
  master update occurs when a later release omits a record.
- `medicine_import_releases` retains counts, report, provenance and package/licence hashes;
  `medicine_import_source_rows` retains source values; `medicine_import_generics` and
  `medicine_import_brands` retain linked source candidates. New releases keep prior
  mappings separate so changes require a fresh review.

## Clinical mapping workspace

After deployment and import, open **Platform → Imported medicines and mappings**
(`/platform/medicine-imports`). Select a release, search by generic, brand or source code,
then choose **Edit mapping**. Search and related brands are paginated; the full release is
never downloaded into the browser.

The form shows original ingredient names, form, routes and linked brands. Source ingredient
names are proposed as editable names. Strengths, clinical route/form and regulatory evidence
start unmapped. A generic name containing a strength is not parsed into a dosage. A numeric
strength requires a positive value, unit and denominator. A percentage instead has no extra
denominator, is capped at 100 and requires evidence of its concentration basis in the reason
field. IU and percentages remain in their original entered units; no mass conversion is
inferred. A non-numeric strength decision
requires a reason. Any additions, omissions or duplicate source ingredients are rejected.

Save incomplete work as **Draft mapping**. To record an externally supplied clinician review,
complete form, route, ingredient/strength decisions, regulatory evidence, review notes,
clinician name and registration/council, then attest that the named clinician supplied it.
This is a recorded attestation, not independent credential verification, a digital signature
or prescribing approval. An operator must not claim a clinician reviewed a record without
that review. No real record is pre-marked clinically reviewed by the importer.

Each save checks the expected revision, appends an immutable history row with the recording
operator and timestamp, and writes an audit event in the same transaction. Conflicting edits
return 409. Old revisions remain visible under **Mapping history**. Platform operators can
edit a previously reviewed mapping only as a fresh draft in the browser; changes clear its
attestation so the review must be confirmed again. Platform operators can
edit mapping fields only; source names/content are immutable. Clinic, patient and general
authentication roles cannot access these private tables. The console network allowlist and
separate platform sign-in apply to all endpoints; responses are not cached.

Before a future clinical publication path is enabled, approval evidence must be verified,
reviewer credentials/sign-off checked, source-to-clinical molecule identities resolved,
strength/form/route compatibility validated and the safety-data scope independently reviewed.
The current source and mapping records never establish absence of interactions or safe doses.

## Verified private import — 13 November 2026

Archive SHA-256: `aebd30ac95d73accf573c86fd4dae1dc90eff03ae0fbcd312bc761011e88270a`.
Version: `archive-aebd30ac95d73acc` (archive-derived, not an asserted source release date).

| Measure | Count |
| --- | ---: |
| Original brand rows | 93,911 |
| Original generic rows | 10,305 |
| Indexed source rows across seven tables | 188,578 |
| Linked generic candidates | 10,304 |
| Linked brand candidates | 93,694 |
| Quarantined brand rows | 217 |
| Generic reference issues | 1 |
| Real clinical reviews recorded | 0 |

One generic repeats a route identifier. Strict validation quarantines it, affecting 203
brands. Another 13 brands have unresolved generic links; one brand has malformed columns.
That explains the difference from the earlier raw-link inspection's 14-brand count.
All original files and the complete quarantine report are retained privately.

This import is in a separate persistent local PostgreSQL database under
`.data/medicine-import-private/`, with a private import summary and provenance alongside it.
It is not the hosted database. No source records have been committed to GitHub, copied into
an image or activated for prescribing. Importing into a later deployment requires running
the same owner command against its intended database; never replace the production database
with the private local staging cluster.


## Work through the review queue

In **Platform → Imported medicines and mappings**, open a release and choose a
**Review status** before pressing **Search**:

- **Not started**: no saved mapping exists.
- **Draft mapping**: an operator has saved work, but no clinician review is recorded.
- **Clinician review recorded**: the operator has recorded the named clinician's review;
  this does not grant prescribing approval.
- **All mappings**: the complete generic queue.

The filter combines with generic name, brand name or source-code search. **Load more**
uses the last submitted search and status, even if the form has since been edited;
press **Search** to apply new values. Filters run before pagination.

These screens read the database connected to that deployment. A private local import
will not appear on the hosted site until the reviewed application and source import are
installed there. The queue does not activate medicines or change pending licence status.
