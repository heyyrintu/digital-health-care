# ADR 0022: Cashfree refund ledger and explicit recovery

- Status: Accepted
- Date: 2026-11-04
- Extends: ADR 0021 and ADR 0013

## Decision

Refunds are distinct from gross collections. Keep original payments, receipts, charged bill lines, gross paid amounts and collection state unchanged. A confirmed refund appends a separate money-out entry, with an RF-numbered printable voucher. Bill and daily reports show refunded and net-collected totals separately. This prevents a refund from making the bill due and charging the patient again. Daily reports use ledger posting time; imported historic refunds are recognized when verified, rather than rewriting an earlier report. Net collection may be negative on a refund-only day.

A clinic admin explicitly confirms a partial/full refund against a verified Cashfree receipt with an amount and nonclinical reason code. The server synchronizes provider/dashboard refunds and verifies the single credited successful transaction before reserving more funds. An unresolved app request prevents another request for that payment; confirmed/reserved amounts cap app requests to the original payment. Refunds from other provider transactions on the same order are flagged rather than attributed to the wrong receipt.

Persist the immutable request before HTTP. Use `rf` plus the request UUID without hyphens as Cashfree's merchant refund ID, and the UUID as the provider idempotency key. Send exact paise converted to decimal INR, a generic `Clinic refund` note and STANDARD speed; no clinical text is sent. First query that refund ID; create only if absent. Ambiguous responses keep the original reservation. A status check never submits money. Only an explicit admin recovery action can reuse the original create request. The UI retains that UUID and disables cancellation of an uncertain submission until recovery succeeds.

Match original merchant/environment, order, credited payment, merchant/provider refund IDs, amount and currency on every provider update. Known IDs/amounts are immutable. SUCCESS posts once under the bill lock and cannot regress on an older pending/cancelled callback. Verified cancellation/rejection releases that request's capacity; an unrecognized/FAILED result is held for review. Provider-origin refunds can be imported from signed callbacks or server checks, without initiating funds movement. Confirmed totals are capped by an append-only ledger; a deferred database constraint forbids committing succeeded state without its entry. Unknown identities, excessive amounts or a different payment flag the order for manual review, with no automatic attribution or clearing.

All callback processing uses the existing raw-body HMAC verification and original stored order mapping. Sanitized hashes/IDs/outcomes are stored atomically with status/ledger/audit changes before acknowledgement. No raw bank/customer payload, ARN or provider note is retained. Refund requests and vouchers are tenant-scoped; only the internal payment role writes financial records. Admins initiate/recover; normal billing staff can read, check and print.

`CASHFREE_REFUNDS_ENABLED=false` is the default and independent of pausing new checkout. Disabling new refunds leaves reads/checks/callbacks available while the Cashfree integration and original merchant credentials remain configured. No real refund is sent during automated tests.

## Limits

Refunds of manually recorded cash/UPI/card payments are outside this adapter. Automatic nightly reconciliation, automated review resolution, native refund screens and WhatsApp notifications remain pending. Cashfree applies its own refund eligibility window and bank processing rules; the ledger's receipt-posting date is not substituted for the provider's original transaction date.

## Provider references checked

- [Create refund, UUID idempotency and supported speed](https://www.cashfree.com/docs/api-reference/payments/latest/refunds/create-refund)
- [Get refund and terminal/pending states](https://www.cashfree.com/docs/api-reference/payments/latest/refunds/get-refund)
- [List existing order refunds](https://www.cashfree.com/docs/api-reference/payments/latest/refunds/get-all-refunds-for-an-order)
- [Refund webhook payload and types](https://www.cashfree.com/docs/api-reference/payments/latest/refunds/webhooks)
- [Raw-body signature verification](https://www.cashfree.com/docs/payments/online/webhooks/signature-verification)
