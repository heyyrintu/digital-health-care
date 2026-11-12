# Medicine catalogue staging

This operator tool prepares **synthetic** catalogue review artifacts. It has no database,
network, environment-file loading, publication or deactivation operation. It is not an
administration page in the hosted app. CDCI/SNOMED licensing and real-data publication
remain deferred by the owner.

## Run the example

From the repository root, with Node 22 and installed workspace dependencies:

```sh
pnpm --filter @dhc/api medicines:stage \
  --input test/fixtures/cdci-synthetic \
  --output /private/tmp/dhc-medicine-stage-example
```

The output directory must not exist. To compare another completed run:

```sh
pnpm --filter @dhc/api medicines:stage \
  --input test/fixtures/cdci-synthetic \
  --output /private/tmp/dhc-medicine-stage-repeat \
  --previous /private/tmp/dhc-medicine-stage-example
```

`--previous` takes the **stage directory**, not a JSON file. The command verifies its
completion marker, catalogue checksum and fingerprint before comparing records. Reusing
a dataset/version for different source bytes fails; choose a new source version for a
changed release. Identical reruns produce the same source fingerprint and unchanged rows.

The supplied fixture has two linked candidates and one deliberately broken brand. It is
entirely fabricated and does not include the downloaded real catalogue.

## Input contract

`manifest.json` has exactly four keys. The supplied fixture uses:

```json
{
  "format": "cdci-flat-files/v1",
  "dataKind": "synthetic",
  "datasetKey": "synthetic-medicine-catalogue",
  "version": "fixture-1"
}
```

`format` must be `cdci-flat-files/v1` and `dataKind` must be `synthetic`.
Choose `datasetKey` (1–80 lowercase letters, digits, dots, underscores or hyphens;
start with a letter or digit) and a nonblank `version` of up to 80 characters.
Use a new version for a changed release; the fixture values are examples.

Supply the seven `*Master.txt` files in the same directory: Brand, Generic, Product,
Supplier, Substance, DrugForm and RouteOfAdministration. Files are UTF-8 TSV. The parser
supports quoted fields, BOM, CRLF, embedded tabs/newlines, and empty trailing cells.
Identifier strings are preserved without numeric conversion. Required headers are named
explicitly; reordered columns are supported. Use an immutable input folder while staging.

A `synthetic` declaration is an operator assertion, not proof of a licence or of origin.
Do not relabel real data as synthetic. Real-data manifest kinds are rejected in this
increment, and there is no `--publish`/`--apply` flag.

Bounds: 32 MiB per source table, 64 MiB total source text, 200,000 data rows per table,
100,000 characters per field, 100 columns, and 256 MiB per output artifact. Symlink/device
inputs and invalid UTF-8 are rejected. Outputs use a new private directory and private files.

## Review artifacts

| File | Purpose |
| --- | --- |
| `catalogue.json` | Linked candidates with external source IDs, names, ingredient/route/form references and review requirements |
| `report.json` | Table counts and quarantined row identifiers, line numbers and reasons |
| `provenance.json` | Dataset/version and SHA-256 checksums of the exact seven source files, including any BOM |
| `delta.json` | Optional additions, changes, unchanged IDs and missing IDs requiring review |
| `COMPLETE.json` | Written last; fingerprint plus checksums of the generated files |

Treat a directory without `COMPLETE.json` as incomplete. Never use a failed/partial run.
A successful exit means a review report was prepared, not that every row was accepted or
that any catalogue is clinically approved. Indexed-row counts describe unique, named IDs;
reference failures are reported separately and exclude affected brand candidates.

Duplicate identifiers quarantine **all** conflicting rows, even when identical. Broken
product/supplier/generic references, invalid generic ingredient/route/form references,
missing names, invalid dates and malformed rows exclude affected brand candidates.
Malformed headers/quoting stop the entire run. Missing rows in a later release are only
review signals; the tool never deletes/deactivates existing medicines.

All candidates have `clinicalSafety: not_assessed` and `publicationAllowed: false`.
Strengths/doses are not inferred from names; free-text safety narratives are not promoted
to clinical rules. Regulatory status UNKNOWN stays UNKNOWN. Do not substitute this output
for interaction, dose, pregnancy or allergy evidence. JSON artifacts deliberately avoid
spreadsheet formula execution; no CSV export is produced.

## Remaining work before real publication

1. Confirm the applicable affiliate licence and retain source attribution/terms.
2. Add durable source-ID/version mappings and private staging/review storage to the app.
3. Have a clinician review ingredient strengths/units, supported route mappings, coverage
   and regulatory information; resolve quarantined rows explicitly.
4. Implement authorized review/publication with audit and regression tests. Preserve
   clinic-owned medicines and signed prescription snapshots; keep clinical safety facts
   separately sourced and reviewed.

Validation for this increment covers malformed tables, duplicate/missing references,
unsafe numeric-ID conversion, release diffs, private artifacts, overwrite protection,
file/encoding bounds, checksum tampering and the actual CLI. No live data was imported.


## Platform sandbox review

After applying migration `20261112093000_medicine_catalogue_review`, sign in to the
platform console and open **Medicine catalogue review** (`/platform/medicines`).
Clinic staff and patient accounts cannot access this workflow. The platform network
allowlist still applies.

1. Stage the fabricated fixture using the command above. Small stages produce
   `review-bundle.json` alongside the usual checksum-protected artifacts.
2. Upload that bundle. Browser imports allow 1–500 candidates, at most 2,000 report
   entries and 2 MiB of JSON. Larger runs keep their normal offline artifacts but do
   not produce a browser bundle. Uploads are limited to five per minute per address.
3. Inspect candidates, quarantine reasons, source checksums and changes from the
   active sandbox. Numeric source IDs remain strings. Unknown regulatory status and
   unassessed clinical safety are shown explicitly; no dosing or safety approval is inferred.
4. Write a 10–1,000-character review note and acknowledge synthetic-only scope, then
   mark reviewed or reject. Review decisions and staged payloads are immutable.
5. Publish a reviewed snapshot to the **sandbox only**. This changes one platform-only
   active pointer. It never inserts, updates or deletes clinical medicines or prescriptions.
   Missing source records are a review count; they do not deactivate anything.
6. To reactivate an earlier published sandbox snapshot, select it and publish again.
   If a reviewer or active release changed meanwhile, reload before deciding again;
   stale requests fail rather than overwriting a newer decision.

A repeated upload of the same bundle returns its original snapshot. A changed bundle
under the same dataset/version is rejected; create a new version through the staging
command. Review/upload/publication events record operator and stage identifiers in the
audit trail, without copying candidate names or review notes into audit metadata.

The bundle's hashes verify internal metadata consistency, not authenticity. Raw source
files are not uploaded, so the server cannot reproduce the candidate derivation. The uploader
must ensure all contents are fabricated. Real CDCI content remains deferred until the
owner confirms applicable licensing. There is no real-data publishing switch or API in
this increment, and no clinic can prescribe from this sandbox.

Expansion bounds: linked generic and candidate JSON each have a conservative 64 MiB
budget, counted before retaining each expanded record. Every artifact also has a
128 MiB conservative estimate checked before serialization, in addition to the final
256 MiB output-byte cap. Oversized expansions fail instead of exhausting memory.
