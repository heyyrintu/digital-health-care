# Import patients from a previous system

1. Sign in as clinic admin and open **Patient import**. Download the sample CSV or export
   a patient register from your previous system. Work with an authorised copy of the export.
2. Use UTF-8 CSV with a header, at most 100 patients and 256 KiB per file. Split larger
   registers into batches. Excel users should save as CSV UTF-8. Native XLSX is not accepted.
3. Enter a stable source label such as `previous_emr`. Reuse this exact label and the
   previous system's stable patient ID on subsequent files; changing either may conceal
   that a person was imported before. Never use names as legacy IDs.
4. Map columns for legacy ID, name and mobile. Optional fields are birth date (`YYYY-MM-DD`),
   gender (`female`, `male`, `other`), email, address and legacy UHID. Mobile numbers must be
   valid Indian mobiles; spaces and common +91/91/0 prefixes are normalized. Verify that
   numbers still belong to the intended people before import. Guardian relationships must
   be handled separately through registration.
5. Run the dry-run preview. This creates no patients. Correct every error in the source
   file, then make a new preview. Do not change IDs merely to bypass a duplicate warning.
   Existing patients/UHIDs and repeated identities need manual review; existing records
   are never overwritten or automatically merged. Distinct family members may share a
   number, but every shared-contact warning requires review.
6. Review every mapped value and acknowledge permission/current number ownership. Confirm
   the import within 24 hours. The whole batch succeeds or no patients are created. Any
   new match or warning since preview requires a fresh dry run. Only its creator can
   confirm or cancel a preview.
7. If the connection fails during confirmation, retry **the same preview**. A committed
   result is returned safely. After a browser reload, open it under **Recent imports**.
   Re-uploading unchanged source IDs skips those records; changed source data is blocked
   for manual review. A completed import links to each patient.

Leave legacy UHID unmapped to use the clinic's next number. To preserve one, use 1–40
letters, digits, `/` or `-`; it must be unique in the clinic. Generated numbers skip both
existing UHIDs and explicit legacy UHIDs anywhere in the batch. Imported profiles have
no pre-granted consent or new login credentials; normal verified sign-in/consent rules apply.

Cancel only unapplied previews. Completed imports have immutable source provenance and
cannot be cancelled to erase people who may already have appointments or care records.
Correct individual demographics through the existing patient workflow; use the existing
reviewed merge process when appropriate. Import history contains encrypted demographic
previews/results and remains retained after application expiry.

This guide covers demographics only. Historical notes, prescriptions, visits, attachments,
balances and other clinical/financial migration require a separate validated migration.
Use the [historical export intake checklist](../data/historical-emr-intake.md) to prepare
the source sample and identify the required mapping and clinical-review decisions.
Before a real clinic migration, rehearse against a nonproduction copy, reconcile counts
and sampled fields with the source, verify UHID allocation and arrange a tested backup and
doctor/clinic sign-off. No real source data is used by the automated development tests.
