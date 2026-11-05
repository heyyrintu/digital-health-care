# Webhooks Guide

**Status:** Draft · **Owner:** Backend lead

All inbound webhooks follow the same pattern: **verify → store → acknowledge fast → process in a worker → de-duplicate**.

## Common pipeline
1. Verify the provider signature (and timestamp where provided). Reject and log anything that fails.
2. Store the raw event in `WebhookEvent` (provider, provider event ID, received at, signature valid).
3. Return `200` quickly (within a few seconds); never do business work in the request.
4. A worker processes the event; if `(provider, eventId)` was already processed, it is skipped.
5. Processing is idempotent: applying an event twice gives the same state.
6. Failures retry with backoff; after the final retry the event goes to a dead-letter list on the ops dashboard.

## Cashfree Payments

Implemented collection path (ADR 0021): `POST /v1/webhooks/cashfree` verifies the timestamp plus exact raw bytes with the original stored organisation's merchant secret. The untrusted payload only supplies a candidate order ID; a restricted lookup maps it to the committed order before signature verification. Success must match that order, amount and currency. Failed/user-dropped attempts do not mark the whole order failed or downgrade a paid order. Provider payment IDs and unique order receipts prevent double-credit even when retry payloads differ.

This bounded financial callback uses one database transaction for sanitized event metadata, receipt numbering, payment, bill balance and audit; it returns 200 only after commit, and returns an error for a retry after rollback. This deliberately differs from the generic raw-event/worker pipeline above: no raw customer, bank or instrument payload is retained, and no Redis dependency is needed to credit a verified payment. Delayed signed retries are accepted; raw-event hash and business-source deduplication make replays harmless. Unexpected amounts/currencies/additional successful transactions are held for review. Refund and settlement events below are future scope.

Target event coverage:
| Event | Effect |
|---|---|
| Payment success | Mark payment Success; bill → Paid / Partly paid; generate receipt; notify patient; confirm booking if pay-at-booking |
| Payment failed / user dropped | Mark attempt Failed; booking hold continues until expiry; patient can retry |
| Refund status | Update Refund and bill status; notify patient |
| Settlement | Store Settlement; used by nightly reconciliation |

Rules:
- Verify the signature using the organisation's Cashfree secret (tenant resolved from the order ID prefix / stored mapping, never from untrusted payload fields alone).
- The app's success callback never marks a bill paid; the server also checks order status with Cashfree when the app returns.
- Cashfree may deliver the same webhook more than once — de-duplication is mandatory.
- Amount and currency in the event must match the stored order; mismatches are flagged, not applied.

## WhatsApp (Meta Cloud API directly)

Implemented for OTP and appointment delivery: `GET /v1/webhooks/whatsapp` verifies Meta's challenge and `POST /v1/webhooks/whatsapp` verifies the raw-body `X-Hub-Signature-256`, checks the configured account/sender and saves sanitized receipts before acknowledging. An internal correlation ID and stored provider message ID route receipts to the original organisation. Raw payloads, recipient numbers and error descriptions are not saved. A durable PostgreSQL inbox feeds the `webhooks` BullMQ worker; retries and out-of-order events are idempotent. `GET /v1/delivery-log` and the clinic-admin WhatsApp delivery page expose metadata only. [Setup and recovery](../runbooks/whatsapp-otp.md).

A successful send response means acceptance, not delivery. The table below is the target for general messaging: status processing is built for OTPs and opted-in appointment confirmations/reminders; signed STOP handling is implemented, with hashed message-ID deduplication and revision-aware revocation. General inbound chats, buttons, other notification types and SMS fallback remain deferred. Unlike the future generic raw-event store, this authentication callback stores only sanitized status metadata to avoid retaining sensitive inbound content.
| Event | Effect |
|---|---|
| Message status (sent, delivered, read, failed) | Update DeliveryLog; failure or no delivery within 5 minutes triggers SMS fallback |
| Button reply (Confirm, Reschedule, Cancel, Book, Pay) | Map to appointment / bill action for that patient |
| Free-text inbound | Create or update MessageThread; open 24-hour service window; notify front desk |
| Opt-out (STOP), implemented | Revoke matching appointment opt-ins on this recipient/sender, including organisations sharing the sender; suppress queued notices. OTP login remains separate. |

## SMS provider (DLT)
Delivery reports update DeliveryLog; failures are visible in the admin delivery log.

## ABDM gateway
Callbacks for ABHA verification, care-context linking, consent notifications (granted, denied, revoked, expired) and health-information requests/transfers. All ABDM callbacks are processed by the `abdm` module and logged with the consent artefact ID.

## Testing
- Each provider's sandbox in dev and staging.
- Contract tests replay recorded sandbox payloads (no real patient data) including duplicates and bad signatures.
