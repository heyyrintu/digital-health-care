# ADR 0035: reviewed CSV patient imports

Status: implemented locally, 7 November 2026. Source-system and clinic acceptance remain separate.

## Decision

Clinic admins import patient demographics through a bounded UTF-8 CSV wizard. A file has
at most 100 patient rows, 40 columns and 256 KiB. Headers are unique; ambiguous quoting,
inconsistent widths, null bytes and oversized cells are rejected. Quoted commas, newlines,
escaped quotes, CRLF and a UTF-8 BOM are supported. Spreadsheet expressions remain text.

Admins choose a stable source label and explicitly map legacy patient ID, name and Indian
mobile number. Date of birth, gender, email, address and legacy UHID are optional. Names,
phone numbers, email and dates are normalized/validated consistently with registration.
Blank UHIDs use the clinic allocator, reserving legacy UHIDs elsewhere in the file.
Patients without their own mobile/known family contact require manual guardian registration.

The dry run writes no patients. It freezes normalized rows, errors and shared-number
warnings in encrypted storage. Raw CSV and unmapped columns are discarded. Stable preview
IDs recover an interrupted response and reject changed input. Confirmation is limited to
the creating admin, requires explicit acknowledgement, expires after 24 hours and applies
the whole batch in one database transaction. Any erroneous row blocks the batch.

Duplicate external IDs, UHIDs, name-plus-phone and name-plus-date-of-birth matches are
blocked. Matching includes closed/merged register records conservatively; admins review
them manually. Shared phone numbers with different identities are warnings, since families
may share one contact. There is no automatic merge, overwrite or matching to an existing
record. A normalized row hash plus clinic/source/external-ID provenance makes an unchanged
re-upload a skip; changed source data requires manual review. Merged or closed prior
imports cannot be silently revived.

Confirmation rechecks matches and warnings. Changed results require a new dry run. Import
operations serialize per clinic, acquire sorted phone locks shared with registration, and
recheck unique identifiers. Manual patient creation/updates share the clinic import lock.
Retries of a committed apply return its original result without creating patients again.
Cancellation is available only before application; applied history cannot be erased or
rewritten. No automatic rollback deletes patients that might have acquired care history.

Tenant RLS protects previews and provenance; only clinic admins have HTTP access. Platform
roles receive no table grants. Views and mutations are audited with IDs/counts, never
uploaded values. Preview/result ciphertext is retained as operational history; 24-hour
expiry prevents application and does not automatically delete retained history. Owned
patient downloads include only that patient's source/external-ID provenance, never another
person's row or the full import batch.

## Boundaries

This implements demographic onboarding, column mapping, duplicate validation, dry runs,
confirmed application and recovery. It does not import clinical notes, historical visits,
prescriptions, bills, attachments, accounts, consents or WhatsApp preferences. It sends no
messages. Historical clinical migration needs a source export, provenance/mapping rules,
clinical permissions and doctor validation before it can be claimed complete.

See the [operator guide](../runbooks/patient-import.md). Real source export rehearsal,
backup/restore acceptance and hosted deployment remain separate from local synthetic tests.

Validation: all 55 migrations applied to disposable PostgreSQL; 15 import integration
cases and 41 patient-register/tenant-isolation/data-rights regression cases passed.
The 100-row capacity case, creator-only confirmation, stale preview rollback, concurrent
apply/re-upload recovery and patient-only provenance export are covered. All 26 scoped
lint/type/unit-check tasks passed. Eleven mobile/desktop browser checks passed across
imports, patient registration, People and profile editing, including interrupted-response
recovery and invalid-file replacement. API/web production builds, formatting and diff
checks passed. All test records and source files are synthetic.
