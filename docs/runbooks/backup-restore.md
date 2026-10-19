# Runbook: Backup and Restore

**Owner:** DevOps · **Targets:** recovery point 15 minutes, recovery time 4 hours.

## Backups
- RDS: automated daily snapshots + point-in-time recovery (continuous logs); cross-Region copies only after the data-residency stance is confirmed with the lawyer (default: keep within India). If approved, use RDS automated backup replication (snapshots and transaction logs, encrypted) to the second Region, which can be restored; a snapshot export to S3 is for analysis only and cannot be restored.
- S3: versioning and object lock on clinical buckets; lifecycle rules aligned with retention classes.
- Infrastructure: Terraform state versioned.

## Monthly restore drill
1. Restore the latest snapshot to an isolated environment.
2. Run integrity checks (row counts per table, latest prescription hashes match S3 PDFs).
3. Record time taken and issues; fix gaps.

## Real restore
1. Declare incident (`incident-response.md`).
2. Choose restore point; restore to a new instance; validate.
3. Point the API to the restored database during a maintenance window; replay queued webhooks from providers where possible (Cashfree order status checks for the gap period).
4. Reconcile payments and messages for the gap; inform the clinic.

## Orphaned logo files
Clinic logos live in the file store under `organisations/<organisation id>/branding/logo-<random>.<ext>` (ADR 0017 addendum 2). A replaced or removed logo's file is deleted after the change commits; if that deletion fails, or an upload's outcome cannot be checked, the API logs an error (`Could not remove the replaced logo`, `Could not remove the removed logo`, `Could not remove the logo of a failed upload`, `Could not check a failed logo upload; its file stays`) and the file stays with no row pointing at it. Such a file is never served (the logo route finds files only through `organisation_branding`) and holds no patient data. There is no automatic sweeper yet. To clean up by hand, after a restore or when the logs show these errors: list the keys under `organisations/*/branding/`, compare them with `SELECT logo_key FROM organisation_branding WHERE logo_key IS NOT NULL` (owner connection, read only), and delete keys not in the list that are older than a day (a newer one may belong to an upload still in flight). After a restore to an earlier point, files of logos uploaded after that point are orphans in the same way; logos whose rows point at files missing from the restored store answer 404 until the clinic admin uploads again.
