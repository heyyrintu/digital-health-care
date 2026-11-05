# ADR 0019 — Opted-in appointment messages through a transactional outbox

Date: 4 November 2026

## Context

Appointment messaging follows WhatsApp OTP delivery and receipt tracking; live environment configuration is separate from development. Appointment notifications need explicit number-holder agreement, consistent timing, and protection against cancellations, changed recipients, duplicate jobs and uncertain external sends.

## Decision

Extend the existing delivery metadata with message kind, appointment/patient snapshots, consent ID/revision, due/expiry times and sending state. OTP challenges remain a separate source; a database CHECK enforces the source shape. Consent is organisation/phone/sending-number scoped, initially off, versioned, audited and identity-immutable. Staff may record the holder's agreement; patient users may enable only their verified number after current account consents. Revocation is available without health consent, including on the portal consent gate. Signed STOP callbacks revoke grants on the same recipient/sender and store only hashed event IDs; repeat/older events cannot undo a subsequent grant.

A database trigger inserts outbox intent transactionally for eligible confirmed appointments, covering every booking path. One confirmation and one reminder 24 hours before the visit are scheduled; no reminders for bookings already inside that window and no retroactive backfill after opting in. Queued intent expires after 15 minutes and is invalidated on appointment changes. Workers lease IDs, then authorize each send once through a restricted SECURITY DEFINER function that rechecks the current appointment, active practice/doctor/type, live recipient and exact consent revision. Direct table grants remain unchanged; the function releases only the opted-in contact and clinic/time/portal fields needed for this single message, never clinical content.

Before sending, record Sending durably. External requests are bounded and not automatically retried after possible submission. Definite rejection is failed; ambiguous transport/provider results and crashed sends become uncertain. Later verified receipts can reconcile those states. This deliberately prioritizes avoiding duplicate messages over automatic recovery of uncertain sends. In-flight requests cannot be recalled on a later cancellation or opt-out.

Use two reviewed Meta templates with four body parameters (clinic, IST date, IST time, public sign-in portal URL). This increment uses the public login page with no patient IDs or embedded authorization; signed appointment deep links remain future work. A deployment-wide sender/language and web preference controls are sufficient for this increment; SMS fallback, general inbox, buttons, cancellation messages, guardian-number substitution and document/referral delivery remain separate work.

Database connections explicitly request UTC, preserving other connection options. Tests found that the installed Prisma pg adapter replaces a timestamptz offset with UTC rather than applying it; a non-UTC database default therefore shifted comparisons with database time. UTC connections remove that mismatch while the domain and UI retain explicit IST formatting.

## Validation

Fresh PostgreSQL 16 migration tests, booking/authentication/receipt/consent integration suites, provider request and uncertain-send unit tests, and browser flows exercise consent, scheduling, revocation and receipt visibility. External delivery remains disabled by default and requires configured Meta templates/credentials and a Redis-backed staging smoke test.
