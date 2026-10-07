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

## WhatsApp provider (BSP)
| Event | Effect |
|---|---|
| Message status (sent, delivered, read, failed) | Update DeliveryLog; failure or no delivery within 5 minutes triggers SMS fallback |
| Button reply (Confirm, Reschedule, Cancel, Book, Pay) | Map to appointment / bill action for that patient |
| Free-text inbound | Create or update MessageThread; open 24-hour service window; notify front desk |
| Opt-out (STOP) | Set MessagingOptIn to opted-out for WhatsApp across the organisation |

## SMS provider (DLT)
Delivery reports update DeliveryLog; failures are visible in the admin delivery log.

## ABDM gateway
Callbacks for ABHA verification, care-context linking, consent notifications (granted, denied, revoked, expired) and health-information requests/transfers. All ABDM callbacks are processed by the `abdm` module and logged with the consent artefact ID.

## Testing
- Each provider's sandbox in dev and staging.
- Contract tests replay recorded sandbox payloads (no real patient data) including duplicates and bad signatures.
