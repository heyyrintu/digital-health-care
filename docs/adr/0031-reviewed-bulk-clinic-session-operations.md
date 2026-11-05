# ADR 0031: Reviewed bulk clinic session operations

Status: Implemented locally; provider/pilot acceptance outstanding
Date: 2026-11-05

## Decision

Provide `/clinic/session-operations` for reviewed cancellation, rescheduling and delay updates. Active front desk and clinic admins can manage clinic sessions; doctors are limited to their own sessions. Patient sessions have no access. Every operation requires a source doctor, clinic, India-calendar date, time range and operational reason. Rescheduling preserves the doctor, patient/live merged record, consultation type, original reason/source and relative spacing, with no automatic overbooking or bill transfer.

## Frozen preview and atomic apply

POST `/v1/clinic-operations/preview` records an immutable encrypted plan under a caller-supplied UUID. It reads at most 200 overlapping source appointments and accepts at most 50 eligible changes. Larger sessions must be narrowed by time. Billed/prepaid, started/non-booked and clinical-record bookings are shown as unchanged exceptions for cancellation/move; delay estimates can apply to today's pending/confirmed/checked-in waiting visits without modifying their financial or care records. The clinician's private content is never returned by this workflow; eligibility uses record existence/revisions only.

A keyed snapshot covers source identities, times/statuses, patient/merge revisions and financial/clinical references. Proposed targets are displayed before confirmation and checked against current matching slots, duplicate bookings and the source closure range. Targets retain the source spacing; there is no auto-packing, multi-doctor reassignment or hidden overbooking. A conflicted target requires another destination preview or individual scheduling.

Applying requires the preview creator's explicit confirmation and acknowledgement of every unchanged exception. Previews expire after 15 minutes. The transaction locks the operation and source rows in stable order, then takes the existing doctor/day booking locks and re-reads the complete source selection. New bookings, status/financial changes, merges or a newly started visit invalidate the preview. Destination allocation uses the same checked placement routine as individual booking. Any failure rolls back all replacements, cancellations, history, closures and notice intents.

Cancellation/move also adds a doctor/clinic part-day leave exception for the selected source interval, including an empty eligible session. Unchanged billed/care bookings remain for individual review and patient contact: closing availability does not silently cancel those visits or refund their payments. Explicit leave/holiday closures also block new walk-ins; walk-ins may still ignore capacity/weekly hours when no explicit closure applies. Existing appointments are not automatically deleted or financially altered.

Applied results are immutable receipts. A replay of an applied operation ID returns the original result without creating replacements or notices. The web UI freezes uncertain apply controls and recovers the same operation after a lost response; do not create a second operation to repeat an unknown result. Historical receipts remain available after reload. Audit records contain IDs/counts/kinds, not patient text or the operational reason.

## Delay estimates

A delay updates `appointments.delay_minutes` and `delay_updated_at`, with a separate append-only operational event. It never shifts the booked time, token, status, bill or prescription. Zero resets the estimate. Staff queue cards and patient appointment lists display the current estimate for waiting bookings and explain that the booked time remains unchanged. Delay updates apply only to today's waiting appointments, not completed/in-consultation care. The estimate is advisory arrival information, not a promised start time or clinical triage decision.

## Additional operational notifications

`WHATSAPP_OPERATIONS_ENABLED=false` by default. The API flag exposes an optional **additional update notice** choice; missing configuration never pretends messages were queued. Normal replacement confirmation/reminder intents remain governed by their existing settings and may coexist with this extra notice. Disabling the extra option does not disable the clinic's normal booking notices.

Each eligible affected visit can create an immutable `clinic_operational_updates` event. A restricted function creates one `appointment_update` delivery per event/sender only when a current live patient/guardian contact has matching appointment-category WhatsApp consent. These notices use the existing shared automated-notification sender, separate from dedicated conversational inbox numbers. Repeated family bookings can produce more than one generic notice; this is per-appointment, not a household campaign.

The worker's separate `appointment-update` job carries only a delivery UUID. `messaging_begin_operational_notice` rechecks the applied source event, current cancellation/replacement/delay, live recipient/guardian, portal closure, consent version/sender/category, clinic/organisation and expiry before one-time authorization. STOP/consent revocation skip queued intents. Superseded delay estimates and replacement bookings that have already changed do not send stale updates. Expired or crash-interrupted sends are not automatically duplicated; an unknown provider outcome remains uncertain. Existing signed receipt handling supports callback-before-response and preserves stronger read/delivered states.

The approved utility template has exactly two text BODY parameters: clinic name and an authenticated patient-portal login URL. No patient name, source reason, medical information, exact appointment time, delay or payment data is sent by this generic update. The recipient signs in to see current owned information or contacts the clinic. Queued/accepted are not proof of delivery; the receipt reports queue counts and staff must contact anyone not reached. Actual Meta credentials, template approval, worker/Redis operation and delivery acceptance are later staging work.

The delivery's `operational_update_id` identifies its source; its legacy `appointment_id` is null. This keeps repeated delay operations independently deduplicated without colliding with the existing confirmation/reminder appointment key. Source checks follow the operational event's appointment and optional replacement. Clinical/financial rows are retained.

## Scope limits

This is one doctor/clinic/day/time interval per reviewed operation, with at most 50 eligible changes. Automatic prepaid refunds/transfers, bulk doctor substitution, arbitrary per-patient target editing/packing, multi-day campaigns, SMS, exceptional care overrides and full notification-template administration remain outside this increment. Existing availability management can explicitly reopen a session later. Native work is paused; cloud DSC/AI remain deferred. No PR, deployment or real outbound message is part of local validation.
