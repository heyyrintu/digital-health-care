# ADR 0025: Authenticated patient finance and opted-in availability notices

- Status: Implemented locally; real provider acceptance pending
- Date: 2026-11-05

## Decision

Complete the web payment journey with a family-scoped payments page, bill balances, receipt history, original receipt viewing/printing and separate confirmed refund updates. Patient routes independently require current consents and current number/guardian/merged-history ownership inside tenant transactions. A signed pay-only link never grants receipt or patient-record access. Staff receipt output remains unchanged; the portal adds a separate refund supplement rather than altering original amounts or reopening refunded bills.

Lists use bounded cursor pagination and optional owned-patient filtering. Bill summaries batch their source/aggregate queries. Checkout takes a stable UUID only; exact remaining balance comes from the locked bill. Dependants use the account's verified number. Unknown responses recover the original order. Expired unresolved attempts need verified provider closure before another collection. Prepaid reservations retain their own payment controls and cannot be replaced through generic dues checkout. Server verification, not browser return parameters, confirms payment. Checkout UUIDs are normalized before constructing provider order IDs.

Introduce an independent `payments` WhatsApp opt-in. Appointment/record consent never authorizes financial notices. Immutable source events enqueue one notice per source/sender for an active payment order, posted receipt or posted refund entry. This is transactional with the source; no historical backfill is implied. No phone, clinical notes, patient names or amounts enter queue payloads: jobs contain delivery UUIDs only. Meta receives the recipient number and one generic template parameter: an expiring authenticated navigation link. The configured approved template language follows the existing notice setup; full per-recipient/per-organisation template administration remains separate work.

At send authorization, re-check the active organisation, source tenant/identity/state, current live patient/guardian contact and exact consent revision. Closed, paid, expired or changed-recipient links are skipped. Receipt/refund notices refer only to posted financial records. Database source guards and unique indexes bind each notice to its financial event and sender. STOP/revocation cancels queued notices; a send already authorized cannot be recalled. Existing delivery callbacks/logs handle the new kinds.

Use a dedicated financial navigation secret and HMAC purpose, separate from record navigation and Cashfree pay-only tokens. The web opener requires sign-in to the intended clinic and re-checks family ownership before resolving a destination. Payment notices resolve only to the original currently payable order; receipt/refund notices resolve to an owned original receipt with its separate refund updates. Links expire after at most one hour and never outlive the payment-link deadline. The authenticated history remains available after notice expiry. Keep the API secret configured while pausing new sends so existing links can expire normally.

Workers claim durable notices through the restricted messaging functions. One send authorization permits at most one external attempt. Transport uncertainty/process crash is recorded as uncertain, never automatically resent. Redis publication failures can recover before sending; they do not recreate financial records. A notice does not initiate payment/refund or prove bank credit.

## Configuration and boundaries

`WHATSAPP_PAYMENTS_ENABLED=false` defaults off on API and workers. Enabling requires the existing Meta sender/access/version setup, signed callbacks/STOP, `WHATSAPP_PAYMENT_LINK_SECRET`, a generic approved `WHATSAPP_PAYMENT_TEMPLATE` and its language, HTTPS portal origin, database and Redis workers. Counter receipts can be notified without enabling new Cashfree collection; paying dues still requires the original clinic Cashfree setup. Credentials remain external. No real sends or money movements were made during implementation.

Web receipts use the shared existing A5 receipt layout; browser Print/Save as PDF provides export. Receipt/refund supplements display original gross amounts and separate refund posting entries. Native checkout, email/SMS, receipt PDF attachments, repeated/manual resend automation and the wider inbox/template-management plan are not implemented by this increment.

## Validation

Fresh PostgreSQL migration; family/tenant/guardian/merged-history access, consent withdrawal, bounded pagination, exact-balance checkout/recovery, UUID casing, unchanged original receipts, refund balances, separate opt-ins, deduplicated source events, expiring/purpose-bound authenticated links, STOP, changed recipients, paid-link suppression and uncertain-attempt non-retry. Worker transport tests use a synthetic fetcher. Full web browser coverage includes the patient finance/print journey and existing billing, payments, refunds, prepaid booking, records and notifications. Real Meta template delivery and Cashfree sandbox acceptance remain required before enablement.
