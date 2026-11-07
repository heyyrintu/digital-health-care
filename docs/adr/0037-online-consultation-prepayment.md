# ADR 0037: Prepaid audio/video web bookings

- Status: Implemented locally; provider acceptance and deployment pending
- Date: 2026-11-07

## Decision

Extend ADR 0024's existing Cashfree reservation and checkout flow to audio/video types
when the clinic enables online consultations (ADR 0036). The payment integration,
prepaid-booking switch, current clinic merchant, acceptance of new payments and supporting
client opt-in must all allow a new prepaid booking. Without those payment gates, only
non-prepaid online types appear. Without clinic online enablement, neither online type
appears. Booking and slot checks still require an active doctor with verified, completed
registration details; chat remains unavailable.

No new provider endpoints, credentials, tables or migration are introduced. Reuse the
server-priced immutable bill, original provider order, stable request UUID, atomic slot
hold, 35-minute lead time, verified callbacks, numbered receipt and captured clinic
approval rule. An unpaid hold cannot be manually confirmed or used for online intake,
joining, consultation start or signing. Successful payment does not replace the separate
identity/guardian declaration, appointment-specific consent, doctor check or joining
window. A paid manually approved booking still waits for clinic confirmation.

Preserve original-order recovery, provider-confirmed expiry/closure, uncertain holds,
late-payment review and explicit admin refunds. Cancelling the appointment or withdrawing
online consent does not automatically refund a successful payment. Disabling online
consultations stops new online bookings and join access; it does not erase existing
payment obligations or stop signed callbacks/recovery. Staff must contact the patient and
use the established refund workflow when care cannot be delivered. Prepaid rescheduling
remains clinic-assisted; no automatic transfer of payment, consent or provider room is added.

## Validation and limits

Integration tests exercise both audio and video: supporting-client options, clinic and
payment gates, verified doctor requirements, free-booking bypass rejection, unpaid hold
protection, duplicate verified payment, one receipt, consent/identity verification, private
joining and withdrawal. Existing reservation, expiry, uncertainty, manual approval and
refund tests continue covering the shared payment processor. Browser checks cover payment
fee text, reservation/checkout/server confirmation for both modes at 390px and 1280px,
plus the existing online identity/guardian/withdrawal flow. Test gateways and intercepted
external destinations send no real messages, payments or calls.

Actual Cashfree sandbox checkout, termination, callbacks, refunds, clinic admission/call
acceptance and clinical/policy sign-off remain separate launch gates. Production Cashfree
and online consultations stay disabled until those gates are met. Native checkout, SMS,
AI and cloud DSC retain their existing paused/deferred status.
