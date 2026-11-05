# ADR 0021: Cashfree collection for existing bills

- Status: Accepted
- Date: 2026-11-04
- Extends: ADR 0013

## Decision

Deliver a complete existing-bill collection flow before prepaid booking, refunds and settlement matching. Each organisation configures its own distinct merchant client ID/secret/environment in the server secret store. The API uses fixed sandbox/production hosts and the documented `2026-01-01` API. No credentials, card/UPI details or clinical content are passed through application forms.

The server locks the bill, prices the exact remaining balance and creates one immutable intent, with a deterministic provider order ID and UUID idempotency key. Original minimal request details (direct mobile number and callback/return URLs) and checkout session are encrypted at rest. A retry reuses the intent, first fetching the provider order and then using the identical create payload/idempotency key if necessary. Ambiguous errors retain the reservation; no new order or counter collection is allowed until recovery. Bill edits and counter payments use the same bill lock and database guards.

Public links are HMAC-signed pay-only capabilities with a separate secret. They expose clinic label, amount, currency, state and expiry; they grant no clinical, receipt or patient-session access. Checkout is available for 30 minutes. Status remains available for 24 hours afterwards. The provider session goes only to a valid active link; the SDK loads only on explicit Pay on the isolated public page. Pages and API responses use no-store/no-referrer; pages are noindex. The checkout return performs a server check. Browser results/redirect parameters never prove payment.

Callbacks are verified against timestamp plus exact raw body, using the original merchant identified by the committed order mapping. A bounded database transaction records sanitized event metadata and applies a single numbered receipt/bill update atomically before acknowledgement. This specializes the generic raw-event/worker plan: financial credit does not depend on Redis, raw financial/customer payloads are not retained, and rollback leaves the callback retryable. Repeated raw events and repeated provider payment IDs/order credits are independently deduplicated. Delayed signed retries are allowed; deduplication and monotonic financial state prevent replay credit or regression.

Status reconciliation checks the original merchant, order ID/amount/currency, and the successful payment ID/amount/currency. Amounts use exact whole paise; mismatches and unsupported captured-state combinations require review. A provider-confirmed pending termination keeps the reservation; only confirmed termination/expiry with no successful or pending payment releases it. Local expiry alone never releases the bill. A late successful payment or additional success cannot over-credit the bill; discrepancies are audited for clinic review. Online receipts use the initiating staff ID for provenance, but do not label that staff member as the person receiving cash.

`CASHFREE_ENABLED=false` is the default. `CASHFREE_ACCEPT_NEW_PAYMENTS=false` pauses creation/checkout while allowing existing callbacks and checks. Credentials and original merchant bindings must remain configured while payments are outstanding.

## Limits and next increments

No real gateway call or transaction is made by automated validation. A real sandbox pilot is required before enabling live collection. This increment does not implement refunds, nightly settlement reconciliation/mismatch dashboard, prepaid booking holds, native checkout, automated WhatsApp delivery of links/receipts, or an automated resolution tool for review cases. No PR or deployment is part of this change.

## Provider references checked

- [Create order and idempotency](https://www.cashfree.com/docs/api-reference/payments/latest/orders/create-order)
- [Fetch payments for an order](https://www.cashfree.com/docs/api-reference/payments/latest/payments/get-payments-for-an-order)
- [Raw-body signature verification](https://www.cashfree.com/docs/payments/online/webhooks/signature-verification)
- [Payment webhook formats](https://www.cashfree.com/docs/api-reference/payments/latest/payments/webhooks)
- [Hosted web checkout](https://www.cashfree.com/docs/payments/online/web/redirect)
- [Termination states](https://www.cashfree.com/docs/api-reference/payments/latest/orders/terminate-order)
