# Historical EMR migration: source intake and mapping

Status: preparation only, 7 November 2026. No historical clinical importer or deployment
is claimed by this document. The demographic CSV importer remains implemented separately
under ADR 0035. A source export is required before choosing a clinical source adapter.

## First source sample

Identify the previous EMR, its export version if available, and the supplied file formats.
Keep its original column names, date formats, folder layout and relationship identifiers.
A small anonymised sample should show two patients, one patient with multiple visits,
one prescription and one attachment reference when those exports exist. Replace personal
details and clinical text while keeping references consistent across files. Do not include
credentials, access tokens or real medical documents in the development repository.

Do not manually rewrite a full production export into a guessed format. The adapter must
describe what the source actually contains, including missing values and ambiguous dates.
If only PDFs are available, document that limitation; structured visit or medication data
must not be invented from filenames or guessed from a scanned page.

## Mapping decisions to establish from the sample

| Source information | Required interpretation |
| --- | --- |
| Source system and export identifier | Stable clinic-scoped origin and immutable batch identity |
| Legacy patient ID | Resolve through `patient_import_records` using the exact source label and external ID; never identify a clinical record by name or phone alone |
| Legacy encounter ID | Stable source identity for replay/deduplication; establish whether IDs are unique per patient or per clinic |
| Encounter date/time | Preserve source value, precision and documented timezone; reject ambiguity rather than silently assigning a current date/time |
| Original clinician ID/name | Preserve source attribution separately from the reviewing local doctor; do not impersonate a local account |
| Clinical notes | Preserve original sections/text in encrypted historical storage; record missing sections explicitly |
| Prescription ID/date/original document | Preserve as a historical source record with verification status; do not create a newly signed platform prescription, signature, QR verification or dispense instruction |
| Medication data | Establish source units, dose/frequency/duration conventions and free text; require explicit mapping and clinical review before any structured use |
| Attachment references | Resolve within the provided archive/manifest and exact patient/encounter; record media type, byte length and content hash |
| Changed/repeated/deleted records | Define immutable source identity and content-hash conflict reporting; do not overwrite previously accepted clinical history |
| Financial rows, balances and payments | Keep outside clinical migration until separate amount/currency/ledger reconciliation rules are agreed |

Unknown, missing, duplicated, merged or closed patient matches require manual resolution.
An unmatched historical record must not create a new patient automatically or assign one
from a similar name. Exported author names are source attribution, not proof of credentials
or evidence that a local doctor has reviewed the material.

## Proposed reviewed workflow

This workflow is a design requirement for the future clinical importer, not current UI.

1. Authorised clinic admin registers the source batch and reviews counts and patient-ID
   mappings. Clinical text is restricted to doctors with the existing chart permissions;
   operational import permissions do not grant clinical access.
2. Validate source structure, stable identities, dates and exact patient/encounter links.
   Freeze a dry run with blocking errors and explicit warnings. No clinical chart is
   changed by uploading or previewing a source batch.
3. Quarantine attachments through existing media verification and scanner controls before
   they become readable. Reject missing files, hash mismatches, unsafe archive paths,
   unsupported types and suspicious/encrypted content under the configured file policy.
   Preserve the source hash separately from any sanitised display copy's hash.
4. An authorised doctor reviews a fixed content version for a fixed matched patient and
   accepts or rejects it with recorded reviewer/time. Mapping/content changes invalidate
   the review. Historical attribution and local review are separate fields.
5. Accepted entries appear with an explicit historical-source label and original date.
   They must not create live appointments, current medication orders, new prescriptions,
   bills, payments, consents or outgoing messages as a side effect.
6. Retain immutable batch/source/content provenance, audited decisions, safe retry receipts
   and explicit correction events. Rejected entries stay out of the chart. Decide retention
   and patient-portal visibility before implementing acceptance, including patient-only
   export and account-closure handling.

The existing `PatientRecordsService` is patient-origin and consent/share based. Historical
clinic migration must not bypass it by inventing a patient uploader or a patient share.
The existing `SigningService` creates a new platform prescription after current checks;
it must not be called to turn an old prescription into a newly signed document.

## Acceptance evidence needed

- Source-to-preview-to-accepted count reconciliation, including rejected/unmatched rows.
- Doctor comparison of sampled original notes/prescriptions/documents with their displayed
  historical copies and attribution; no inferred clinical facts.
- Exact identity/tenant permissions, closed/merged patient handling and source conflicts.
- Tampered/missing attachments, scanning failures, archive path checks and file integrity.
- Interrupted upload/review/apply, duplicate replay, concurrency and rollback without orphan
  files or duplicate clinical entries.
- Patient-only export/visibility rules, retention and correction decisions.
- A nonproduction rehearsal with the actual export, tested backup/restore, clinic sign-off
  and a separately authorised deployment. Synthetic fixtures alone do not establish this.

## Current dependency

Historical migration is deferred at the owner's request. When resumed, obtain the source
system name, export format and anonymised sample. No source field mapping,
archive parser, historical clinical schema or doctor-review implementation is final until
the sample establishes the actual relationships and record formats.
