# Runbook: Backup and Restore

**Owner:** DevOps · **Targets:** recovery point 15 minutes, recovery time 4 hours.

## Backups
- RDS: automated daily snapshots + point-in-time recovery (continuous logs); snapshots copied to a second region bucket encrypted (confirm data-residency stance with lawyer before enabling cross-region; default keep within India).
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
