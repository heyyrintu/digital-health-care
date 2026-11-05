# ADR 0026 — Patient web self-rescheduling

Date: 2026-11-05. Status: accepted for local implementation.

## Decision

Add an authenticated family appointment detail endpoint and a strict `startAt`-only rescheduling endpoint. The web appointment list offers a new-time flow for pending/confirmed in-person visits before the clinic cancellation cutoff. Keep the original doctor, clinic, consultation type, reason and source. A bill, prepaid reservation, inactive clinic/type, online mode or prepayment-required type requires clinic assistance. Prepaid reservations remain governed by ADR 0024, including after payment.

Require current portal consents and current account/guardian/merged-history access. Resolve merged history to the live patient for the replacement. Hold a shared consultation-type lock to stabilize payment policy, serialize with other patient bookings and lock the original visit, matching billing's visit lock. Recheck eligibility inside the transaction. Apply current patient booking horizon, same-day cutoff, availability, doctor activation, duplicate visit and missed-appointment rules. A move replaces one upcoming booking and does not increase the active-booking count. The clinic's current automatic/manual confirmation policy governs the replacement.

Create the replacement and its history, link it to the old appointment, mark the old appointment rescheduled and record the audit event in one transaction. Failed moves leave the original slot untouched. Existing appointment notification rules suppress obsolete queued notices and independently evaluate the replacement; no new messaging consent is inferred.

Use one Idempotency-Key per chosen replacement. An uncertain browser result freezes date/time choices and offers recovery with the same key. A definitive refusal allows another choice. Concurrent different requests cannot create two replacements. The authenticated appointment list remains the recovery source after navigation or session loss.

## Boundaries and validation

English/Hindi web screens; no native UI/build changes or deployment. Billed/prepaid changes, refunds and online consultations remain clinic-assisted. No new database migration or external provider is needed.

API coverage includes dependants, foreign access, strict input, busy/out-of-horizon/same-time refusal, original slot retention, idempotent replay, concurrent replacements, merged history, manual approval, active-booking limit and billed/cutoff refusal. Browser coverage books a real appointment, loses the successful reschedule response, retries the original key and verifies exactly one linked replacement. Existing prepaid and finance suites cover payment protections alongside the new flow.

Validation: all 42 API integration suites passed (594 passed, one Redis-dependent queue-health test skipped because TEST_REDIS_URL was not configured). After the final consultation-policy lock, 37 focused booking/prepaid/finance integration tests passed. The complete 66-test browser suite passed; interrupted-response rescheduling was additionally repeated at 390px and 1280px against the final API build (both passed). All 52 scoped web/API/worker/shared checks passed, followed by 16 API/browser check tasks after the safeguard. Formatting and diff checks passed. These are local synthetic checks; live-provider and deployment acceptance remain open.
