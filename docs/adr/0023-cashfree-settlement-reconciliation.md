# ADR 0023: Read-only settlement reconciliation with immutable snapshots

- Status: Accepted, implemented locally; live provider validation pending
- Date: 2026-11-05

## Decision

Clinic administrators may queue a report for 1–31 completed IST days. A nightly worker queues a rolling seven-day report after 01:00 IST, once per account/day. Each request captures the original merchant client ID and environment. Credential rotation for the same account is allowed; a different account/environment fails safely. All Cashfree transport, schemas and merchant parsing live in `@dhc/cashfree`; `@dhc/reconciliation` owns the shared processor and matcher.

Use [Get All Settlements](https://www.cashfree.com/docs/api-reference/payments/latest/settlement-reconciliation/get-all-settlements), [PG reconciliation](https://www.cashfree.com/docs/api-reference/payments/latest/pg-reconciliation/pg-reconciliation), and [settlement reconciliation](https://www.cashfree.com/docs/api-reference/payments/latest/settlement-reconciliation/settlement-reconciliation), pinned to API `2026-01-01`. POST requests read reports only; they initiate no money movement. Fixed provider hosts, timeouts, response/page/row limits, cursor-loop detection and strict normalization bound each scan. Settlement breakdown is fetched by returned settlement IDs rather than assuming its date window equals the payment event window. Do not publish any partial scan.

Keep gross payments, fees, tax, adjustments, net, status and UTR separate. For PREPAID reports, compare net with gross minus fees and tax plus signed adjustments. Unsupported charging bases and all adjustments/disputes require review. Do not impose this equation on each event: provider examples report event and aggregate amounts differently. Match successful PAYMENT events with immutable order, merchant/environment, INR amount and credited provider payment ID. Match REFUND events only when the report supplies one unambiguous merchant refund reference; never guess it from `event_id`. Missing references and transactions become review items. Compare receipt/voucher posting dates with the PG event window, acknowledging that imported or delayed records may use different dates.

Persist only financial identifiers, statuses and amounts; strip customer, bank, instrument and note objects. Monetary fields use exact paise and PostgreSQL bigint; API values are bounded safe integers. Snapshots have tenant RLS, append-only result triggers and restricted internal-write grants. No patient names/phone numbers appear in queue payloads or reports. Source links are validated against the report tenant.

Requests live in the database, independently of Redis. Dispatch leases recover lost queue publication. Processing uses row locks, UUID fencing tokens, per-page heartbeats and bounded retries, with atomic publication in a final transaction. A crash on attempt five becomes failed after lease expiry. Old/stale workers cannot publish. Completed snapshots cannot be overwritten. Acknowledgement may add a reviewer/time/reason only after successful publication and creates an audit event. It never changes bills, receipts, refund entries, source review flags or the historical mismatch count.

Cashfree's status is a provider report. Confirm the UTR/net against the bank statement before treating it as bank receipt; [Cashfree's settlement explanation](https://www.cashfree.com/blog/payment-settlement-cycle-explained/) describes separate settlement and bank processing. No bank feed, automatic correction or dispute resolution is implemented here.

## Consequences and validation

Both API and workers require `CASHFREE_RECONCILIATION_ENABLED=true` and matching merchant configuration; default false. Reporting is independent of new payment/refund gates. A seven-day rolling window does not cover every possible delay or outage: operators can extend it up to 31 days and request older windows. No automatic full-history backfill is implied.

Provider transport and matcher unit tests, real PostgreSQL migration/RLS/immutability/retry/fencing tests, existing billing/payment/refund regressions, and an admin browser flow cover local behavior. Real report availability, pagination and fee/adjustment semantics for the configured merchant must still be checked in Cashfree sandbox before enablement.
