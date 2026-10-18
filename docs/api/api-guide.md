# API Guide

**Status:** Draft · **Owner:** Backend lead · **Source of truth:** `packages/contracts` (Zod) → generated OpenAPI 3.1 → generated typed client (`packages/api-client`).

This guide explains conventions and lists the endpoint catalogue by module. Field-level detail lives in the generated OpenAPI reference; do not duplicate it here.

## 1. Basics

| Item | Convention |
|---|---|
| Base URL | `https://api.<domain>/v1` (production), `https://api.staging.<domain>/v1` (staging) |
| Format | JSON, UTF-8; dates ISO 8601 in UTC (clients display IST) |
| Auth | `Authorization: Bearer <access token>` (short-lived) + rotating refresh token |
| Tenant | Derived from the token; never sent by the client. Platform console uses a separate audience and key, and only from allowed networks (§3s) |
| Idempotency | `Idempotency-Key` header (8–100 letters, digits, `-`, `_`) on retryable writes. Same person, key and body → the first result, replayed for 24 h with `idempotent-replay: true`; built on bookings, appointment actions, bills, payments, the price list and the test catalogue (§3o). Same key with a different body, or while the first request is still running → 409 |
| Pagination | Cursor based: `?limit=50&cursor=<opaque>`; response `{ data, nextCursor }` |
| Versioning | URL major version (`/v1`). Additive changes only within a version. Two latest mobile app versions must keep working |
| Rate limits | Per user and per IP; stricter on OTP, login, upload, payment endpoints. `429` with `Retry-After` |
| CORS | Only the web app's origin (`WEB_BASE_URL`, or the `CORS_ORIGINS` list) may call the API from a browser. No cookies; credentials are never allowed cross-origin |
| Real time | Web: Server-Sent Events `/v1/queue/stream` (staff) and `/v1/display/stream` (waiting-room screens); mobile: WebSocket `/v1/ws`; scribe audio: WebSocket `/v1/scribe/stream` |

## 2. Error shape

```json
{
  "error": {
    "code": "SLOT_TAKEN",
    "message": "This slot was just booked. Pick another time.",
    "fields": { "slotStart": "taken" },
    "requestId": "req_..."
  }
}
```

HTTP status: 400 validation, 401 unauthenticated, 403 forbidden (role or tenant), 404 not found (also used for other tenants' IDs), 409 conflict (state or idempotency mismatch), 422 business rule (e.g. safety block), 429 rate limit, 5xx server. Messages are safe to show to users; never include patient data in error messages or logs.

## 3. Authentication flows

Implemented in Phase 0 (`apps/api/src/modules/auth`). Sign-in requests name the organisation by its slug (the clinic's link), because a person can belong to several organisations.

| Flow | Endpoints |
|---|---|
| Patient OTP | `POST /auth/otp/request` `{organisation, phone}` → `POST /auth/otp/verify` `{challengeId, code}` → tokens. Creates the account and patient membership on first sign-in |
| Staff invite (admin) | `POST /staff/invites` `{identifier, role, displayName?}` → `inviteUrl` (shown once), `GET /staff/invites`, `POST /staff/invites/{id}/revoke` — clinic admin only |
| Staff invite (invitee) | `POST /auth/invites/inspect` `{token}` → `POST /auth/invites/accept` `{token, password}` → `{status: setup_required, otpauthUri}` or `{status: confirm_required}` (409 if account setup changed meanwhile; restart with the current invite link) → `POST /auth/invites/complete` `{token, code}` → tokens |
| Staff list and reset (admin) | `GET /staff/members` (team, roles, whether sign-in is set up); `POST /staff/members/{id}/reset-authenticator` `{role?}` → new setup link (shown once) — clinic admin only |
| Staff login | `POST /auth/login` `{organisation, identifier, password, role?}` → `{status: mfa_required, mfaToken}` → `POST /auth/mfa/verify` `{mfaToken, code}` → tokens |
| Refresh / logout | `POST /auth/refresh` `{refreshToken}` (rotates), `POST /auth/logout` (ends this session) |
| Who am I | `GET /me` → user, organisation, role |
| Biometric unlock | `POST /auth/device/unlock` with device-bound key signature *(not yet built)* |
| Device revoke | `DELETE /auth/devices/{id}` *(not yet built)* |
| Signing approval | `POST /prescriptions/{id}/sign` with biometric assertion or signing PIN *(Phase 1)* |

Rules:
- **Access tokens** are JWTs valid for 15 minutes, carrying user, organisation, role and session. Every request also checks the session is live, so logout or revocation takes effect immediately.
- **Refresh tokens** are opaque, stored only as SHA-256 hashes, and single-use: each refresh returns a new one. Replaying an old one ends the whole session (`auth.refresh.reuse_detected` in the audit log). Sessions last 30 days for patients and 12 hours for staff.
- **Patient codes:** 6 digits, valid 5 minutes, stored as an HMAC, 5 attempts per code, at most 3 codes per number per 10 minutes. Delivery goes through an `OtpSender`; in development `OTP_DELIVERY=log` prints the code (forbidden in production) until the SMS provider is chosen (decision O5).
- **Staff:** passwords hashed with scrypt (at least 12 characters); 5 wrong passwords or codes lock the account for 15 minutes. An authenticator (TOTP) is mandatory and each code works once.
- **Staff accounts are set up only through invites.** Login never offers authenticator enrolment, so knowing someone's password is never enough to attach a new authenticator. A clinic admin's invite link is single-use, expires after 72 hours, is stored only as a hash, and carries its token in the URL fragment (`/invite#<token>`), which browsers do not send to servers or logs. A new invite for the same person and role replaces the previous one; admins can revoke. The invite is used up only when the first authenticator code is confirmed. A person who already has a staff account (another clinic) confirms with their existing password and authenticator instead. The web app's `/invite` page walks the person through these steps; it reads the token from the fragment and removes it from the address bar.
- Unknown user, wrong password and no access in that organisation all return the same `401` message.
- Sign-in endpoints are rate-limited per IP (10 per minute by default).
- **Authenticator reset:** a clinic admin can reset a staff member who lost their authenticator. It clears the person's password and authenticator, ends all their staff sessions, and issues a single-use reset link (same rules as invites); the person sets new ones through `/invite`, and their role is kept. Admins cannot reset themselves, and a person who is staff at another clinic too can only be reset by platform support — otherwise one clinic could take over their access to the other. Support resets have no HTTP endpoint: an operator runs the `support-reset-authenticator` command shipped in the API build ([runbook](../runbooks/support-authenticator-reset.md)), which issues the same kind of reset link for one of the person's clinics, revokes their open links everywhere, and writes `support.authenticator.reset` into every clinic's audit log.
- **Web dashboard:** the browser never holds the refresh token. The web app's `/api/session/*` routes call these endpoints and keep it in an httpOnly cookie, returning only the access token (ADR 0015).
- **Web patient portal** (`/app`): the same, through `/api/patient-session/*` with a cookie of its own; those routes call `/auth/otp/request`, `/auth/otp/verify`, `/auth/refresh` and `/auth/logout`, and the portal then calls the `/portal/*` endpoints (§3r) directly with the access token. No endpoint differs for the web.

## 3a. Patient register

Implemented in Phase 1 (`apps/api/src/modules/patients`). Demographics only: nothing here is clinical, so front desk may use all of it.

| Action | Endpoint | Who |
|---|---|---|
| Search | `GET /patients?q=&tagId=` (name, mobile or UHID; cursor pages) | All staff |
| View | `GET /patients/{id}` → demographics, tags, guardian and family; audited as `patient.viewed` | All staff |
| Check for duplicates | `POST /patients/duplicate-check` `{name, phone?, dob?}` → `{candidates}` | Front desk, doctor, clinic admin |
| Register | `POST /patients` (demographics, `tagIds?`, `allowDuplicate`) → 201 with the new UHID | Front desk, doctor, clinic admin |
| Edit | `PATCH /patients/{id}`: omit a field to keep it, send `null` to clear it | Front desk, doctor, clinic admin |
| Tag | `PUT /patients/{id}/tags` `{tagIds}` (replaces the set) | Front desk, doctor |
| Tags | `GET /tags`; `POST /tags`, `PATCH /tags/{id}` (rename, recolour, `archived`), `POST /tags/defaults` | List: all staff. Change: clinic admin |
| UHID numbering | `GET /uhid-settings` → `{prefix, nextNumber, nextUhid}`; `PUT /uhid-settings` `{prefix, nextNumber}` | Read: all staff. Change: clinic admin |

Rules:
- **UHIDs** are the clinic's prefix followed by the next number, with no separator or padding (prefix `EK` from 10001 gives `EK10001`). Until an admin sets them, numbering starts at `10001` with no prefix. The number is taken under a row lock, so concurrent registrations never share a UHID, and numbers already in use (imported patients keep theirs) are skipped.
- **Duplicates:** a likely duplicate is a patient with the same mobile and name, or the same name and date of birth (names compared ignoring case and extra spaces). Registering returns `409` with `fields.duplicates` (the matching IDs) unless `allowDuplicate` is true; the audit entry records the override. Families share one mobile, so the same number alone is never a duplicate.
- **Families:** one mobile can hold several patients. A patient without a mobile must be linked to a guardian (`guardianPatientId`), one level deep: a guardian has no guardian, and a patient who is someone's guardian cannot be given one. The detail view lists the guardian, dependants and others on the same mobile.
- **Phone numbers** are Indian mobiles in any common format and are stored as E.164 (`+91…`). Dates of birth cannot be in the future.
- **Tags** are archived, never deleted. An archived tag stays on the patients who have it and can be removed, but cannot be newly assigned. Emergency and Priority are marked to sort to the top of the queue (used when the queue is built). `POST /tags/defaults` adds whichever of the six PRD defaults are missing.
- **Audit:** `patient.created` (with `duplicateOverride`), `patient.updated` (field names only, never values), `patient.tags.changed` (tag IDs added and removed), `tag.created`, `tag.updated`, `tag.defaults_added`, `uhid_settings.updated`.

## 3b. Clinics, availability and slots

Implemented in Phase 1 (`apps/api/src/modules/scheduling`; the slot engine is `slotsForDay` in `packages/domain/src/slots.ts`). Times are IST wall-clock `HH:MM`; dates are `YYYY-MM-DD` in IST; fees are integers in paise.

| Action | Endpoint | Who |
|---|---|---|
| Clinics | `GET /clinics`; `POST /clinics` `{name, address?, phone?}`; `PATCH /clinics/{id}` (incl. `active`) | Read: all staff · change: clinic admin |
| Consultation types | `GET /consultation-types`; `POST` `{name, mode, defaultDurationMin, feePaise, followUpFeePaise?, requiresPrepayment}`; `PATCH /consultation-types/{id}` | Read: all staff · change: clinic admin |
| Booking rules | `GET /booking-rules`; `PUT /booking-rules` `{horizonDays, sameDayCutoffMinutes, overbookPerDay, noShowAfterMinutes, maxActiveBookings, noShowLimit, noShowWindowDays, cancelCutoffMinutes, autoConfirm}` (defaults 30, 60, 2, 30, 2, 3, 90, 120 and true; `noShowAfterMinutes` 0–720 or `null` for off, see §3p; the last five govern patient self-booking, §3r) | Read: all staff · change: clinic admin |
| Doctors | `GET /doctors` → active doctors (for pickers) | All staff |
| Weekly schedules | `GET /availability/versions?doctorId&clinicId&consultationTypeId`; `POST /availability/versions` `{doctorUserId?, clinicId, consultationTypeId, effectiveFrom, weekly, slotMinutes?, bufferMinutes}`; `DELETE /availability/versions/{id}` | Read: all staff · change: the doctor (own) or a clinic admin |
| Leave, holidays, extra sessions | `GET /availability/exceptions?doctorId&clinicId&from`; `POST /availability/exceptions` `{type, doctorUserId?, clinicId?, consultationTypeId?, startDate, endDate, startTime?, endTime?, reason?}`; `DELETE /availability/exceptions/{id}` | Read: all staff · leave and extra sessions: the doctor (own) or a clinic admin · holidays: clinic admin |
| Slots | `GET /slots?doctorId&clinicId&consultationTypeId&date&channel=staff\|patient` → `{date, slots: [{start, end, startTime, endTime, available, unavailableReason?}], closed?}` | All staff |

- **Versions, not edits:** a weekly schedule is never changed. `POST` adds a version that applies from `effectiveFrom` (today or later, IST) until a later one; the slots of earlier days never move. A version can be withdrawn (`DELETE`) only before its start date (409 once started). Two versions cannot start on the same day for the same doctor, clinic and type (409). An empty `weekly` means "not consulting from this date".
- **Validation:** sessions must be `HH:MM`, end after they start, fit at least one slot and not overlap on the same day; errors come back per field (`weekly.mon.0`, `weekly.mon`). `slotMinutes` defaults to the consultation type's duration. A doctor's `doctorUserId` defaults to themselves; anyone else's gives 403.
- **Exceptions:** leave and holidays without times cover whole days; with times they remove only the slots they overlap. A holiday without a clinic closes every clinic. Extra sessions need a clinic, a type and times, and use the version's slot length (or the type's duration on an unscheduled day). Start dates are today or later; removal only before the start date. Clinic, type and doctor IDs are checked within the organisation (another organisation's IDs give 400).
- **Slots:** each session is cut into slots back to back, with the buffer after each, never running past the session end. `channel=patient` applies the booking horizon (`closed: beyond_horizon`) and the same-day cutoff (`unavailableReason: cutoff`); staff see past slots as `past` and may book further ahead. `busy` will mark booked slots once appointments land. A whole day off returns `closed: leave | holiday | no_schedule | past`.
- **Audit:** `clinic.created|updated`, `consultation_type.created|updated`, `booking_rules.updated`, `availability.version_created|version_deleted`, `availability.exception_created|exception_deleted` (IDs, dates and types only).

## 3c. Appointments

Implemented in Phase 1 (`apps/api/src/modules/appointments`). Staff booking only for now; patient self-booking, holds and payment come with the patient app and Cashfree.

| Action | Endpoint | Who |
|---|---|---|
| Day list | `GET /appointments?date&doctorId&clinicId` (date defaults to today, IST; ordered by time) | All staff |
| Patient's appointments | `GET /appointments?patientId` (newest first, any day) | All staff |
| View | `GET /appointments/{id}` → appointment with its status history | All staff |
| Book | `POST /appointments` `{patientId, doctorUserId, clinicId, consultationTypeId, startAt, overbook?, reason?}` → 201 | Front desk, doctor, clinic admin |
| Walk-in | `POST /appointments` with `walkIn: true` and no `startAt` → 201, checked in today | Front desk, doctor, clinic admin |
| Status change | `POST /appointments/{id}/actions` `{action, reason?}` | See below |
| Reschedule | `POST /appointments/{id}/reschedule` `{startAt, doctorUserId?, clinicId?, consultationTypeId?, overbook?}` → 201 with the new appointment | Front desk, doctor, clinic admin |

- **Slots:** `startAt` must be the start of one of the doctor's slots that day (`GET /slots`). A taken slot gives `SLOT_TAKEN` (409); with `overbook: true` it is allowed while the doctor has fewer than `overbookPerDay` overbooked patients that day, else `BOOKING_LIMIT` (409). Past slots and made-up times also give `SLOT_TAKEN`. Bookings for one doctor and day are serialised with a transaction-scoped Postgres advisory lock, so concurrent requests can never share a slot. Status changes and reschedules lock the appointment's row first, so two simultaneous changes to one appointment cannot both succeed (the second gets 409).
- **Busy slots:** pending, booked, checked-in, in-consultation and completed appointments mark their slot busy in `GET /slots` for that doctor at every clinic; cancelled, no-show and rescheduled ones free it. Walk-ins hold no slot.
- **Tokens** number each doctor's patients per clinic per day, in booking order (walk-ins included). A rescheduled booking gets a new token on its new day.
- **One per day:** a patient cannot hold two active bookings with the same doctor on one day (409; reschedule instead).
- **Actions and roles:** `confirm` (pending → confirmed; front desk, doctor, admin), `check_in` (pending/confirmed → checked in; on the day only; front desk, doctor), `start` and `complete` (checked in → in consultation → completed; the patient's own doctor only), `cancel` (needs `reason`; front desk, doctor, admin), `no_show` (after the slot starts; front desk, doctor). Anything else gives 409. Staff bookings are created confirmed; walk-ins are created checked in. Bookings nobody checks in become no-shows automatically once the clinic's grace period has passed (§3p).
- **Reschedule** works on pending or confirmed bookings: the new appointment is checked like a fresh booking (its own slot may be the old one's), the old one becomes `rescheduled` and the two are linked (`rescheduledFromId` / `rescheduledToId`).
- **Audit:** `appointment.created`, `appointment.status_changed`, `appointment.rescheduled` (IDs, dates, statuses and source only; never reasons or patient details). Every status change is also kept in the appointment's history with who and when.

## 3d. Queue and waiting-room screens

Implemented in Phase 1 (`apps/api/src/modules/queue`).

| Action | Endpoint | Who |
|---|---|---|
| Queue | `GET /queue?date&doctorId&clinicId` → `{date, myOpd, booked, followUps, completed, closed, averageConsultationMinutes}` (date defaults to today, IST) | All staff |
| Screens | `GET /display-screens`; `POST /display-screens` `{clinicId, label}` → 201 with the `link` (shown once); `POST /display-screens/{id}/revoke` → 204 | Clinic admin |
| Screen board | `POST /display/board` `{token}` → `{clinicName, date, doctors: [{doctorName, nowServing, next}]}` | Public (the screen's token; rate limited) |

- **Tabs:** `myOpd` is the patient in consultation first, then checked-in patients — those with a "show first" tag (Emergency, Priority) ahead of the rest, then by check-in time; `booked` is pending and confirmed by time; `completed` is newest first; `closed` is cancelled, no-show and rescheduled; `followUps` is the patients due back that day (§3p), a list of its own that does not change the other tabs. `averageConsultationMinutes` is the mean of the day's completed consultations (start to completion). The web queue refreshes when `/queue/stream` reports a change (§3o) and every 60 seconds as a fallback.
- **Screens** are kiosk links `…/display#<token>`: 32 random bytes, stored only as a SHA-256 hash, never in a URL path (the token stays in the fragment and travels in the request body), so it does not reach server logs. A screen shows, per doctor, the token in consultation and the next five waiting, in queue order; never patient names. Revoked or unknown tokens give 404. (Build plan §6 names the route `/display/[clinic]`; a guessable clinic ID in the path was replaced by the token link.)
- **Audit:** `display_screen.created`, `display_screen.revoked`.

## 3e. Patient chart, vitals and consultation notes

Implemented in Phase 1 (`apps/api/src/modules/clinical`). Prescriptions, the safety engine and signing follow in the next slices.

| Action | Endpoint | Who |
|---|---|---|
| Chart | `GET /patients/{id}/chart` → `{patientId, allergies, conditions, medications, recentVisits}` | Doctor |
| Add to chart | `POST /patients/{id}/allergies` `{substance, reaction?, source?}`; `POST /patients/{id}/conditions` `{name, icd10Code?, source?}`; `POST /patients/{id}/medications` `{name, dose?, source?}` → 201 | Doctor |
| Remove from chart | `POST /patients/{id}/allergies\|conditions\|medications/{entryId}/remove` `{reason}` → 204 | Doctor |
| Vitals | `GET /appointments/{id}/vitals` → `{vitals}`; `PUT /appointments/{id}/vitals` `{bpSystolic?, bpDiastolic?, pulse?, temperatureC?, spo2?, weightKg?, heightCm?, painScore?, pregnancyStatus?}` | Front desk, doctor |
| Consultation | `GET /appointments/{id}/consultation` → `{appointment, consultation, vitals, canEdit}`; `PUT /appointments/{id}/consultation` `{notes, followUpDate, revision}` | Doctor (writing: the visit's doctor) |

- **Access (PRD §3.2):** chart and notes are doctors' only, shared across the organisation's doctors by default (the "shared chart" model); under "own patients only" (§3l) a doctor needs the patient checked in to them first. Front desk records vitals; clinic admins have no clinical access. Every view and change is audited (`chart.viewed`, `allergy|condition|medication.added|removed`, `vitals.viewed|saved`, `consultation.viewed|saved`) with IDs, revisions and removal reasons only.
- **Chart entries** are never deleted: removing one keeps it with who, when and why, because past prescriptions were checked against it. `source: patient` marks patient-reported entries, shown as unverified (safety rule SR-21).
- **Vitals** are one set per visit. `PUT` replaces the whole set (readings left out are cleared), within plausible ranges (400 otherwise). BMI is worked out from weight and height. Allowed while the visit is pending, booked, checked in, in consultation or completed; 409 for cancelled, no-show or rescheduled visits.
- **Notes** (`chiefComplaint`, `symptoms[{text, duration}]`, `examination`, `diagnoses[{code, label}]`, `plan`, `privateNotes`, `testsAdvised`, `advice`) are stored as one document encrypted with AES-256-GCM (the field cipher); `followUpDate` stays in the clear for reminders. Only the visit's doctor writes, once the patient has checked in (409 before; 403 for another doctor). `revision` must match the stored one (0 for the first save) or the save gets 409 with `fields.revision = stale`, so a second tab cannot overwrite newer notes; each save returns the next revision. Diagnoses may carry an ICD-10 code (a starter list ships in `@dhc/domain`; the full code set comes from a licensed source) or be free text.
- **Locking:** once the visit's prescription is signed (next slices), `lockedAt` is set and notes and vitals give 409.

## 3f. Prescription builder

Implemented in Phase 1 (`apps/api/src/modules/prescribing`), with the safety engine (§3g) and signing (§3i).

| Action | Endpoint | Who |
|---|---|---|
| Medicine search | `GET /medicines?q` (2+ characters; name, generic name or composition; up to 20) | Doctor |
| Draft | `GET /appointments/{id}/prescription` → `{prescription, defaultLanguage, canEdit}`; `PUT /appointments/{id}/prescription` `{language, items, tests?, revision}` (`tests`: the visit's test orders, §3t) | Doctor (writing: the visit's doctor) |
| Repeat last | `GET /patients/{id}/last-prescription?before={appointmentId}` → `{last: {appointmentId, date, doctorName, items} \| null}` | Doctor |
| Safety answers | `POST /appointments/{id}/prescription/safety-actions` `{key, action: acknowledge\|override, reason}` → the updated safety summary | The visit's doctor |
| Templates | `GET /prescription-templates` (own); `POST /prescription-templates` `{name, items}` → 201 (same name replaces); `DELETE /prescription-templates/{id}` → 204 | Doctor |

- **Medicine master:** the platform's reference list (`organisation_id` null; the licensed drug database in production, a synthetic sample of generic products in development and tests) plus medicines the clinic adds (§3k). Row-level security shows each clinic the reference list and its own; separate write policies let it insert and update only its own, so a reference medicine can never be changed or taken over. Inactive medicines are left out of search and rejected on save (400).
- **Lines:** each has a client-chosen `id` (a random UUID, so edits keep it), `medicineId` (null for free text, shown as "not in the medicine list" and sent to the clinic admin's approval queue, §3k), a snapshot of `name`, `composition` and `form`, `route`, `timing`, `steps[{dose, frequency, durationValue, durationUnit}]` (more than one step is a tapering course), `quantity`, `instructions` and `remarks`. Medicine IDs must be active and visible to the clinic (400 otherwise); line IDs must be unique; a step with a duration needs its unit.
- **Remarks:** unless `remarksEdited` is true, the server writes them from the steps, timing and route in the prescription's `language` (English or Hindi) with `dosageRemarks` from `@dhc/domain`, which the web app also uses for the live preview. Frequencies understood: slot patterns (`1-0-1`, with an optional fourth bedtime slot; when any amount is not 1, such as `2-0-2` or `½-0-½`, each slot is written with its own amount — "2 tablets after breakfast and 2 tablets after dinner"; a measured dose such as `500 mg` is repeated, "2 × 500 mg"), `OD`, `BD`, `TDS`, `QID`, `HS`, `SOS`/`PRN`, `STAT`, weekly, monthly and alternate days; anything else is printed as written.
- **Saving** follows the notes rules: only the visit's doctor, once the patient has checked in, with a matching `revision` (409 `revision: stale` otherwise); a signed prescription or locked consultation gives 409 `PRESCRIPTION_LOCKED` (an amendment draft stays writable). A save replaces the draft's lines. `defaultLanguage` is the patient's language. The view also returns `signingMissing` (what stops the visit's doctor signing apart from the safety alerts: `profile`, `verification`, `pin`, `service`), `canAmend` and `versions` (every version, newest first).
- **Repeat last** returns the patient's most recent prescription with lines (any doctor in the organisation) from a visit that started before `before` (the visit being written; 404 if it is not this patient's), or from any visit when `before` is omitted. Lines come without IDs; the client adds new ones.
- **Tests** (§3t) are saved with the lines, under the same revision, so the PDF the doctor previews and signs is the one with these tests. `prescription.tests` lists the visit's tests.
- **Audit:** `prescription.viewed` and `prescription.last_viewed` record entity IDs only (the appointment, or the patient); `prescription.saved` adds the revision, line count and test count; `prescription_template.saved|deleted` record the template ID, with the line count on `saved`. Never medicine names or remarks.

## 3g. Safety engine

The rules are SR-01 to SR-22 in `docs/safety/safety-rule-catalogue.md`, implemented as a pure function, `checkPrescription`, in `@dhc/safety`; the API module is `prescribing/safety.ts`. Drug facts come from the reference drug data tables, never from code: molecule facts, interactions, cross-sensitivities, drug–condition rules, and medicine ingredients with strengths. The licensed database import and clinical sign-off are still pending, so for now development and tests use a synthetic sample that is illustrative only.

- **When it runs:** on every save of a draft, and again when a draft is opened (the chart may have changed: a new allergy, today's weight). The result is returned as `safety` on the prescription: `{alerts, drugDatabaseVersion, openBlocks, openWarnings}`. The server's result is final.
- **Inputs:**
  - The patient's active allergies, conditions and current medicines. Free text is matched to molecules and classes by whole words.
  - Age at the visit date.
  - Today's weight and pregnancy status from this visit's vitals.
  - The consultation type's mode.
  - Whether the same doctor has an earlier completed visit with the patient (the follow-up condition for SR-19).
  - Each line's ingredients and steps. Daily doses are worked out from the dose, the frequency and the ingredient strength; as-needed, weekly, monthly and free-text frequencies have no daily total.
- **An alert:** `{key, ruleId, severity (block|warn|info), itemId, overridable, reasonRequired, unverified, params, message, action, reason, actionAt}`.
  - `key` is the rule, the line and the subject (for example the other molecule, or the exact daily amount for SR-13 and SR-14), so the same problem keeps its answer across saves and a different one (a higher dose) needs a new answer.
  - `params` carries names and numbers for the screen's own wording in English or Hindi; `message` is English, for the log.
  - `unverified` marks alerts based on patient-reported chart entries (SR-21).
- **Answers:**
  - `acknowledge` works only on a warning; it needs a reason when `reasonRequired` is set.
  - `override` works only on a block the drug data allows overriding (`overridable`), and always needs a reason.
  - Anything else is 400. An alert that no longer fires is 409 `key: resolved`.
  - `openBlocks` counts blocks not overridden and `openWarnings` warnings not acknowledged; signing is refused while either is above 0 (§3i).
- **Safety log** (`safety_alerts`):
  - One row per prescription and alert key, with first and last shown times and the drug data version.
  - When an alert stops firing it is resolved, and recorded as `changed` if the doctor had not answered it. If it fires again it reopens.
  - Rows are never deleted; row-level security applies per organisation, and a trigger keeps each row on a prescription of the same organisation.
- **Audit:**
  - `prescription.safety_acknowledged` and `prescription.safety_overridden` record the alert ID, the rule and the drug data version, never the reason text.
  - `prescription.saved` adds the open block and warning counts.
- **Clinic tuning:** a clinic admin can hide SR-06, SR-08 and SR-15 (§3l).
- **Not built yet:**
  - The monthly alert review.
  - Kidney checks from eGFR (only recorded conditions are used today).

## 3h. Billing and counter payments

Implemented in Phase 1 (`apps/api/src/modules/billing`). Cashfree payment links, online checkout, refunds and reconciliation follow in Phase 3 (§6.10 of the build plan).

| Action | Endpoint | Who |
|---|---|---|
| Price list | `GET /price-list` (active and inactive); `POST /price-list` `{name, pricePaise}` → 201; `PATCH /price-list/{id}` `{name?, pricePaise?, active?}` | Read: all staff. Write: clinic admin |
| Bill | `GET /appointments/{id}/bill` → `{bill, consultationTypeName, feePaise, followUpFeePaise, canEdit, canPay}`; `PUT /appointments/{id}/bill` `{revision, consultation, items, discountPaise, discountReason}` | Read: all staff. Write: front desk, doctor |
| Counter payment | `POST /bills/{id}/payments` `{id, mode, amountPaise, reference}` → 201 (200 when the same `id` was already recorded) | Front desk, doctor |
| Receipt | `GET /payments/{id}/receipt` | All staff |
| Collections | `GET /collections?date` (IST day; today by default) | All staff |

- **One bill per visit**, for visits whose patient has arrived (checked in, in consultation or completed; 409 otherwise). The client says *what* to charge, never how much: `consultation` is `consultation` (the type's fee), `follow_up` (its follow-up fee; 400 if it has none) or `none`; `items` are `{priceListItemId, quantity}` (1–99, each item once and on this clinic's list, and a newly added item must be active; 400 otherwise). The server prices every line, snapshots the name and price (when a bill is edited, lines already on it keep their saved price and new lines take today's), and stores `subtotalPaise`, `discountPaise`, `totalPaise` with `billTotals` from `@dhc/domain` (the web preview uses the same function). A discount needs `discountReason` and cannot exceed the subtotal; the lines cannot come to more than ₹1,00,00,000 (400 `items`). Saves follow the notes rules: matching `revision` (0 for a new bill; 409 `revision: stale` otherwise).
- **Fixed after the first payment:** once a bill has a payment its lines and discount cannot change (409), and the database refuses changes to its lines too. Later price-list changes never touch existing bills.
- **Payments** are cash, UPI or card, between ₹0.01 and the balance and at most ₹1,00,000 each (400 above either; 409 when nothing is due). `reference` is kept for UPI and card. The `id` is made by the client and kept until the payment succeeds: repeating it with the same bill, mode and amount returns the recorded payment with 200; anything else with that `id` is 409. Each payment gets the organisation's next receipt number (`R00001`, …), taken under a row lock so simultaneous payments never share one. Payments are append-only. Status follows the amount collected: `due`, `partly_paid`, `paid` (a fully discounted bill is `paid`).
- **Receipts** show the bill's lines and totals, this payment, what was paid up to and including it, and the balance left after it. **Collections** total a day's payments (by IST time received) by mode and by doctor, and list that day's visits whose bills still have a balance.
- **Queue cards** carry `bill: {totalPaise, paidPaise, status} | null` and `prescription: {id, number, version, status: signed|void} | null` (the visit's newest signed or voided version, for printing with `GET /prescriptions/{id}/pdf`; no clinical content).
- **Audit:** `price_list.created` (item ID and price) and `price_list.updated` (item ID, the fields changed and the new price when repriced), `bill.saved` (bill and visit IDs, revision, line count, total and discount), `payment.recorded` (bill ID, mode, amount, receipt number) and `receipt.viewed` (payment ID, receipt number). Never patient names.

## 3i. Signing, amendments and the QR check

Implemented in Phase 1 (`prescribing/signing.ts`, `doctors/`, PRD §6.6, §9.1, §9.4).

| Action | Endpoint | Who |
|---|---|---|
| Prescription pad | `GET /doctor-profile`; `PUT /doctor-profile` `{registrationNumber, council, qualifications, specialty, rxPrefix, paperSize}` | Doctor (own) |
| Signing PIN | `PUT /doctor-profile/signing-pin` `{password, pin}` → 204 | Doctor (own) |
| Preview | `GET /appointments/{id}/prescription/preview` → PDF marked PREVIEW (no number, signature or QR) | Doctor |
| Sign | `POST /appointments/{id}/prescription/sign` `{revision, pin, testIds?}` → the signed prescription | The visit's doctor |
| Amend | `POST /appointments/{id}/prescription/amend` `{reason}` → 201, the new draft version | The visit's doctor |
| Void | `POST /appointments/{id}/prescription/void` `{reason, pin}` → the voided prescription | The visit's doctor |
| PDF | `GET /prescriptions/{id}/pdf` → the signed PDF, or after voiding the copy stamped VOID (front desk: **Print prescription** on the queue card, from the appointment's `prescription`) | Doctor, front desk |
| QR check | `POST /verify` `{code}` → `{status: genuine\|superseded\|void, number, version, latestVersion, signedAt, supersededAt, voidedAt, signatureMethod, doctor, clinicName, patient: {initials, ageYears, gender}, medicines, tests: [{label}]}` | Public (30 per minute per address) |

- **Prescription pad:** registration number, council and qualifications are required, and the prefix (1–8 letters or digits, stored in capitals) is unique in the organisation (409 `rxPrefix: taken`). The platform team verifies the registration from the platform console (§3s), or with the support command `support-verify-doctor` as a fallback (runbook `doctor-verification.md`); changing the registration number or council sends the profile back to pending and to the end of the queue. Paper size is A5 or A4.
- **PIN:** six digits, set with the account password (400 `password: wrong`). It is hashed with scrypt after a server-keyed HMAC, so a database copy alone cannot be guessed offline. Five wrong PINs in a row pause signing and voiding for 15 minutes (429 `pin: locked`); a wrong PIN is 400 `pin: wrong`; no PIN is 422 `pin: unset`. PIN-checked requests share the sign-in rate limit per address.
- **Signing**, in order: the PIN (in its own transaction, so a wrong attempt counts); then under the visit lock the draft must have a medicine or a test (422 otherwise), the `revision` on screen (409 `revision: stale`) and, in `testIds`, every draft test the screen showed (409 `tests: review` when one is missing or an ID is not the visit's; omitted means none, so a client that does not show tests cannot sign them; §3t); the doctor must be verified (403 `DOCTOR_NOT_VERIFIED`) with a complete pad (422 `profile: incomplete`); the safety check runs again and any open block or unanswered warning is 422 `SAFETY_BLOCK` with the counts. Then the number (the doctor's prefix and next running number, e.g. `SG-00042`; an amendment keeps its number), a random 24-character verification code, the PDF, its SHA-256 signed by the signer, and the file stored by key. The visit record (notes and vitals) locks. Without a signer the server answers 503 `SIGNING_UNAVAILABLE`.
- **Signer:** behind an adapter (ADR 0008). Until the cloud Class 3 DSC provider is chosen, `SIGNER=test_key` signs with an Ed25519 key derived from the server secret; the PDF, the record (`signatureMethod: test_key`) and the QR page all say it is not legally valid, and the setting is refused in production. The default is `disabled`.
- **PDF** (template `rx-2`, pdfkit; `rx-1` until test orders): A5 or A4, black and white, labels in the prescription's language with Hindi shaped properly. It prints the doctor (name, qualifications, specialty, registration and council), the clinic, the patient (name, age, gender, UHID), the date, number and version, the consultation mode, the amendment reason, vitals, complaints, diagnoses, allergies, each medicine (name, generic in capitals, every step's dose, frequency and duration, remarks, instructions, quantity; the heading is left out when there are none), "Prescribed tests" (the visit's test orders as "MRI knee, right", each with its note, then the notes' free-text tests advised), advice, follow-up, the signature block with the certificate, the QR with its link, and a disclaimer. Private notes are never printed. The same input renders the same bytes. Files are stored under a key, never a public URL (`FILE_STORE_DIR` until object storage), written once and never overwritten; a file that no longer matches its hash is refused.
- **Amendments:** a new draft version copying the lines (new line IDs), with the reason, writable after the visit record has locked. The signed version stays genuine until the amendment is signed, which marks it superseded.
- **Voiding:** only the newest signed version, with a reason and the PIN; not while an amendment draft is open (409). The signed file is kept unchanged; a copy with a notice page and every page stamped VOID is what the PDF endpoint returns from then on.
- **Immutability:** database triggers refuse any change to a signed version except becoming superseded or void (which touch only those fields), and any change to its lines or safety log. A locked visit record stays locked.
- **QR check:** the code goes in the body, not the URL, so it stays out of logs; it is looked up by its hash. The answer shows initials, never the patient's name. `tests` are the tests that version printed (ordered by it or an earlier version of the visit), as labels in the prescription's language ("MRI knee, right"); never notes or results. The web page shows them under "Prescribed tests" in English or Hindi.
- **Audit:** `prescription.previewed`, `prescription.signed` (version, number, PDF hash, signature method, template and drug data versions, tests ordered), `prescription.amendment_started`, `prescription.voided`, `prescription.pdf_viewed`, `doctor.profile_saved`, `doctor.signing_pin_set`, `doctor.signing_pin_locked`, `support.doctor.verified` (ticket and operator). Never medicine names or reasons beyond what is listed.
- **Not built yet:** delivery to the patient (app, WhatsApp, SMS link, email, ABDM) and notifying the patient of amendments and voiding (with messaging); the cloud DSC provider and PAdES signatures embedded in the PDF; biometric approval on the phone apps.

## 3j. Dashboard figures and audit log

Implemented in Phase 1 (`apps/api/src/modules/reports`, `audit/`, PRD §9.2). Clinic admin only.

| Action | Endpoint | Who |
|---|---|---|
| Figures | `GET /dashboard?from&to` (IST days, inclusive; default the seven days ending today; at most 92 days) → `{from, to, newPatients, appointments, completed, cancelled, noShows, noShowRate, prescriptions, collectionsPaise, byDay}` | Clinic admin |
| Audit log | `GET /audit-log?limit&cursor&action&actorUserId&from&to` → `{data, nextCursor}`, newest first | Clinic admin |

- **Figures:** visits count by their date and leave out those moved to another slot (`rescheduled`); `completed`, `cancelled` and `noShows` are visits with that status. `noShowRate` is no-shows over completed plus no-shows, and null when there are none. `newPatients` counts registrations, `prescriptions` counts first signings (amendments and voided prescriptions are left out) and `collectionsPaise` sums payments received, each by IST time within the range. `byDay` has a row for every day, zeros included. A reversed or longer range is 400 `from: invalid`. Counts are made in the database through row-level security, with the organisation also named in every query.
- **Audit log filters** combine with AND: `action` is an action or its start (`bill.saved`, `prescription.`; lowercase letters, dots and underscores), `actorUserId` one person, and `from`/`to` IST days. The cursor keeps the filters' order.
- **Names:** `actorName` is the staff member's name (or email) when the actor holds a staff role in this organisation; it is null for patients, platform support and system entries, so a patient's name never appears. Records are given by type and ID only.
- **Not built yet:** message cost (with messaging, phase 3) and exports.

## 3k. Medicine list and the approval queue

Implemented in Phase 1 (`apps/api/src/modules/medicines`, PRD §9.2). Everything here is for the clinic admin; doctors search the list with `GET /medicines` (§3f).

| Action | Endpoint | Who |
|---|---|---|
| Medicine list | `GET /medicine-master?q&source=reference\|clinic&includeInactive=true` → `{data, hasMore}` (up to 100, with ingredients) | Clinic admin |
| Add | `POST /medicine-master` `{name, genericName, composition, form, defaultRoute, ingredients[{moleculeId, strengthMg, per: unit\|ml}]}` → 201 | Clinic admin |
| Edit, deactivate | `PUT /medicine-master/{id}` (the same fields plus `active`) | Clinic admin |
| Molecule search | `GET /drug-molecules?q` (2+ characters; name or class; up to 20) | Clinic admin |
| Approval queue | `GET /medicine-requests` → `{pending, decided}` | Clinic admin |
| Decide | `POST /medicine-requests/approve` `{name, medicineId}` or `{name, medicine: {…as Add}}` → 201; `POST /medicine-requests/reject` `{name, reason}` → 201 | Clinic admin |
| Undo | `DELETE /medicine-requests/{id}` → 204 | Clinic admin |

- **Clinic medicines** are the clinic's own (`source: clinic`). Reference medicines are read-only (403 on edit); the name is unique in the clinic ignoring case (409 `name: taken`). Ingredients are molecules from the reference drug data (400 `ingredients: invalid` otherwise), each once, up to 10, with a strength in mg per tablet, capsule or drop (`unit`) or per ml, or no strength at all (creams, IU); a strength needs its unit and the other way round. Saving replaces the ingredients. Without ingredients the safety checks cannot see the medicine and SR-22 warns the doctor. Medicines are deactivated, never deleted; prescriptions keep their snapshot.
- **The queue** is worked out live from prescription lines without a medicine (`medicineId` null, typed by the doctor), grouped by the name in lower case with single spaces, so "Zerodol SP" and "zerodol  sp" are one entry. Each entry has `prescriptions` (how many prescriptions), `doctors` and `lastUsedAt`, most used first; a name typed only in a draft that was later changed drops out on its own. The admin sees names and counts only, never patients.
- **Decisions** are stored per name (`medicine_requests`, one per clinic and name). *Approve* either links the name to an active medicine the clinic can see (400 `medicineId: invalid` otherwise) or adds a new clinic medicine in the same step. From then on a doctor searching the typed name finds that medicine. *Reject* needs a reason and only takes the name out of the queue; doctors can still type it. A second decision on the same name is 409 `name: decided` (decisions on one name are serialised). *Undo* removes the decision and the name returns to the queue if it is still in use; a medicine it added stays in the list. Existing prescription lines are never changed.
- **Audit:** `medicine.created` (medicine ID and ingredient count) and `medicine.updated` (medicine ID, ingredient count and whether active), `medicine_request.approved` and `medicine_request.rejected` (request ID and medicine ID), `medicine_request.undone` (the decision undone). Never reasons or patient details.
- **Not built yet:** the licensed drug database import with its own update process (§3g), and a reference request to the platform team to add a medicine for every clinic.

## 3l. Clinic settings: chart model, safety tuning and upload limits

Implemented in Phase 1 (`apps/api/src/modules/settings`, PRD §9.2). One row per organisation (`organisation_settings`); until a clinic admin saves, the defaults apply.

| Action | Endpoint | Who |
|---|---|---|
| Read | `GET /organisation-settings` → `{chartModel, hiddenSafetyRules, maxUploadMb, uploadTypes}` | Staff |
| Change | `PUT /organisation-settings` (the same four fields, all required) | Clinic admin |

- **Defaults:** `chartModel: shared`, `hiddenSafetyRules: []`, `maxUploadMb: 10`, `uploadTypes: [pdf, jpeg, png]`.
- **Chart model (PRD §3.2):** `shared` lets every doctor in the organisation read every chart. `own_patients` lets a doctor read a patient's chart, a visit's notes and prescription (view, preview, PDF) and "Repeat last" only once that patient has a visit with them that was checked in, in consultation or completed; a booking alone is not enough. Otherwise 403 `CHART_RESTRICTED`. A doctor's own visit is always open to them, but its chart still follows the rule, so the doctor checks the patient in first. Front desk vitals and printing are not affected. Internal referrals open the chart in phase 3. After a merge (§3m) a visit to the kept record or to any duplicate merged into it counts, whichever of those records the request names.
- **Safety tuning (catalogue "Clinic can tune"):** `hiddenSafetyRules` takes only the "Visibility only" rules: `SR-06` (moderate and minor interactions), `SR-08` (duplicate class) and `SR-15` (older-adult caution); anything else is 400, and the database refuses it too. Hidden rules are left out of every check from then on. An alert of a hidden rule already in the safety log is closed without a doctor action. Blocks and the locked rules always show.
- **Upload limits:** `maxUploadMb` 1–25 (the platform's ceiling), `uploadTypes` one or more of `pdf`, `jpeg`, `png` and `heic` (HEIC and HEIF), each once. `checkUpload` in `@dhc/contracts` applies them; the upload endpoints call it on the server (test results, §3t; the general files module later).
- **Audit:** `settings.updated` with each changed field's old and new value; saving the same values writes nothing.

## 3m. Merging duplicate patient records

Implemented in Phase 1 (`apps/api/src/modules/patients/merges.ts`, PRD §3.2, §5.3).

| Action | Endpoint | Who |
|---|---|---|
| Ask | `POST /patient-merges` `{sourcePatientId, targetPatientId, reason}` → 201 | Front desk, doctor, clinic admin |
| Requests | `GET /patient-merges?status=pending\|decided` → `{data}` (pending oldest first; the latest 50 decided) | Clinic admin |
| Approve | `POST /patient-merges/{id}/approve` `{note?}` | Clinic admin |
| Reject | `POST /patient-merges/{id}/reject` `{note}` | Clinic admin |

- **Asking:** the source is the duplicate that closes, the target the record that stays. Both must be this clinic's live records (400 otherwise) and different; a record already in a pending request cannot be in another (409 `merge: pending`; one pending request per source is also enforced in the database). Each side comes back with UHID, name, mobile, date of birth, gender, registration time and completed visits, for the admin to compare. The patient page shows the waiting request (`pendingMerge`).
- **Approving** (one decision at a time per clinic) moves the living record to the target in one transaction: chart entries (allergies, conditions, current medicines, including removed ones with their reasons), tags the target lacks, upcoming bookings nobody has started (pending or confirmed, without vitals or notes), dependants (their guardian becomes the target; a link from the target to the source is dropped), records previously merged into the source, and a patient-app account when the target has none. The source gets `mergedIntoId` and `mergedAt`. Past visits, notes, prescriptions and bills stay where they were written, because signed records never change; they count as the target's from then on. A merge cannot be undone; a decided request gives 409 `merge: decided`.
- **Guardians** stay one level deep: if the source is someone's guardian and the target has a guardian of its own, the request is refused (409 `merge: guardian`) until the family links are changed.
- **Merged records** are read-only: editing, tagging, chart entries and booking give 409 `PATIENT_MERGED` with `fields.patientId` (the record to use). Database triggers refuse anything new pointing at a merged record (visits, chart entries, tags, guardian links, merges). Search and duplicate checks leave merged records out, except a search for the exact old UHID, which returns the merged record with `mergedIntoId` so the client can open the kept one. Patient views carry `mergedInto` and `mergedFrom`.
- **History under the kept record:** the chart, the patient's appointment list, Repeat last and the safety engine's follow-up check (SR-19) include the merged records' visits and prescriptions. A chart requested for a merged record returns the kept record's (`patientId` is the kept one), and an open visit of a merged record is checked against the kept record's chart.
- **Audit:** `patient_merge.requested`, `patient_merge.rejected` and `patient.merged` (request, source and target IDs; for a merge, how many chart entries, tags, bookings and dependants moved). Never names or reasons.

## 3n. Staff devices and sign-out

Implemented in Phase 1 (`apps/api/src/modules/staff`, PRD §9.2 "device revocation"). Clinic admin only.

| Action | Endpoint | Who |
|---|---|---|
| Devices | `GET /staff/members/{id}/sessions` → `{data: [{id, userAgent, ip, signedInAt, lastUsedAt, current}]}`, most recently used first | Clinic admin |
| Sign one out | `POST /staff/sessions/{id}/revoke` → 204 | Clinic admin |
| Sign out everywhere | `POST /staff/members/{id}/sign-out-all` → `{revoked}` | Clinic admin |

- **Scope:** a session belongs to one clinic. The list and both sign-outs only touch this clinic's live staff sessions, so a doctor who also works at another clinic stays signed in there. Another clinic's staff, patients and their sessions read as 404.
- **Effect:** a signed-out session fails on its next request (the bearer check reads the session), and its refresh token stops working. Its push devices (§3q) stop getting notifications in the same transaction (`revokedReason: admin_signout`). The person keeps their access and can sign in again. To also cut access, remove the membership or use **Reset sign-in**.
- `current` marks the admin's own session; the web hides its sign-out button. `lastUsedAt` moves when the session is refreshed, so it can lag by up to one access-token lifetime.
- **Audit:** `staff.session.revoked` (session ID and the staff member's user ID) and `staff.sessions.revoked_all` (user ID and how many were signed out). Revoked sessions keep `revokedReason: admin_signout`.
## 3o. Idempotency keys and the live queue

Implemented in Phase 1 (`apps/api/src/idempotency.ts`, `live.ts`, `sse.ts`).

**Idempotency-Key** (§1) on `POST /appointments`, `POST /appointments/{id}/actions`, `PUT /appointments/{id}/bill`, `POST /bills/{id}/payments`, `POST /price-list` and `POST /test-catalogue/items`:
- Keys are kept per organisation and person (`idempotency_keys`, row-level security) for 24 hours. A retry with the same key and body gets the stored status and body, with `idempotent-replay: true`; nothing runs twice.
- The same key with a different body is 409 `fields.idempotencyKey = reused`. A retry while the first request is still running is 409 `in_progress`, so a double tap never books or charges twice. A badly formed key is 400 `invalid`.
- A write that fails without changing anything (4xx or 5xx) releases its key, so the client can correct and retry under the same key. Each transaction of the write that changes data marks the key in that same transaction, so a retry never runs a write twice: a first attempt that died before writing frees its key after 60 seconds, and one that wrote but lost its response gives 409 `unknown` (check the result before retrying with a new key). Expired keys are deleted by the API's scheduled sweep. Without the header the write runs as before; payments are also safe by their client-chosen `id`.

**Live queue** (server-sent events, replacing 15-second polling):

| Stream | Endpoint | Who |
|---|---|---|
| Staff queue | `GET /queue/stream?date` (IST day, default today) | Staff |
| Waiting-room screen | `POST /display/stream` `{token}` (today) | Public; the screen token is the credential |

- Events: `ready` `{date}` once listening, then `queue` `{appointmentId}` whenever that day's visit, its vitals, bill or prescription status, the patient's tags, or a follow-up due that day changes. Clients refetch `/queue` or `/display/board`; events carry IDs only, never patient details. A comment line every 25 s keeps proxies open.
- Database triggers (`notify_queue_change`) announce changes on the `dhc_queue` channel; each API process holds one `LISTEN` connection, so every instance behind a load balancer hears every change. Staff streams carry the organisation's changes; a waiting-room screen hears only its own clinic.
- The web reconnects with a growing delay (1 to 30 s) and refetches every 60 s as a safety net. Streams use `fetch`, so the bearer token stays in a header. Streams for today end at IST midnight and the client reconnects to the new day. Revoking a screen closes its open stream; the reconnect is 404 and the screen shows that it is no longer linked.

## 3p. Follow-ups and automatic no-shows

Implemented in Phase 1 (`apps/api/src/modules/queue/service.ts`, `apps/api/src/modules/appointments/no-shows.ts`).

- **Follow-ups** (`GET /queue` → `followUps`): every consultation whose follow-up date is the queue's day, filtered by the same `doctorId` and `clinicId` as the rest of the queue, in the order of the earlier visits. Each entry is `{visitAppointmentId, visitDate, followUpDate, patient, doctorUserId, doctorName, clinicId, booking}`; `booking` is the patient's first later appointment with the same doctor that is going ahead or done (pending, confirmed, checked in, in consultation or completed) as `{id, date, startTime, status}`, or `null` when they have not booked. A follow-up booked for another day still counts as booked. Patients appear by name and UHID as on the rest of the queue; notes are never read. A visit to a duplicate merged since (§3m) shows the kept record, and bookings on either count.
- **Automatic no-shows:** a booking still pending or confirmed `noShowAfterMinutes` after its slot **ends** becomes `no_show` (booking rules; default 30, 0–720; `null` turns it off so no-shows are marked by hand only). A no-show does not hold its slot, so the time is free again. The history entry has no actor (`actorUserId: null`, `actorName: null`) and the note "Not checked in N minutes after the slot ended."; the audit entry is `appointment.status_changed` with no actor and `metadata: {from, to: 'no_show', automatic: true}`. Walk-ins are checked in when created and never swept.
- **The sweep** runs inside the API every `NO_SHOW_SWEEP_SECONDS` (default 60; 0 turns it off, as the browser tests do). Each run goes through active clinics one transaction each and closes at most 500 bookings per clinic (the next run takes the rest). Rows are taken with `FOR UPDATE SKIP LOCKED` and their status is read again under the lock, so several API instances can run it at once and a check-in at the same moment either wins or waits; it is never undone by the sweep.
- **Live updates:** each change calls `publishQueueChanged({type: 'queue.changed', organisationId, date, clinicId, doctorUserId, appointmentId, reason: 'no_show'})` (`apps/api/src/modules/queue/live.ts`) after the transaction commits. Until server-sent events land it does nothing, and the queue page picks the change up on its next refresh.

## 3q. Push devices and the offline cache

Implemented for the Clinic app (`apps/api/src/modules/devices`, `apps/api/src/modules/sync`). The Patient app uses the same device endpoints.

| Action | Endpoint | Who |
|---|---|---|
| Register this device | `POST /push-devices` `{platform: ios\|android, appVariant: clinic\|patient, expoPushToken, deviceName?}` → 201 | Anyone signed in |
| My devices | `GET /push-devices` → `{data: [{id, platform, appVariant, deviceName, current, createdAt, lastSeenAt}]}` | Anyone signed in (own, this clinic) |
| Remove one | `DELETE /push-devices/{id}` → 204 | Anyone signed in (own) |
| Medicine cache | `GET /sync/medicines?cursor&limit` → `{data, cursor, hasMore, aliases}` | Doctor |
| Today's working set | `GET /sync/today?clinicId` → `{serverTime, queue, templates}` | All staff |

- **Devices belong to a session.** A device is registered under the access token's session and receives pushes only while that session is signed in. Logout, a refresh-token replay, removed access, an authenticator reset (clinic admin or platform support) and staff sign-out all stop the session's devices in the same transaction, through `revokePushDevicesForSessions(tx, sessionIds, reason, at)` in `devices/revoke.ts`; any new way of ending sessions must call it too. Senders use `pushTargets(tx, organisationId, userIds, now)`, which also skips devices whose session has ended or expired.
- **One row per install.** `expoPushToken` is unique (`ExponentPushToken[…]` or `ExpoPushToken[…]`; anything else is 400). Registering the same token again refreshes `lastSeenAt`; on another session, such as someone else signing in on the reception iPad, it moves there so the previous person stops getting that device's notifications. Registrations of one token are serialised. The token is never returned. Devices are platform-level like sessions: only the sign-in role can read them, and a database trigger refuses a device whose person or clinic differs from its session's.
- **Medicine cache** (ADR 0009). Without `cursor` it is the full download of active medicines the clinic can see (reference and its own), oldest change first, up to `limit` (default and maximum 500) per page; follow `hasMore` with the returned `cursor`. Store the last `cursor` and send it next time to get only what changed, inactive medicines included so the device drops them. Changes from the last 5 seconds are held back until the next call, so a transaction committing late is not skipped. `aliases` is always the clinic's full list of names linked to a medicine in the approval queue (§3k), for offline search. A cursor that cannot be read is 400 `cursor: invalid` (start again without one).
- **Today's working set:** `queue` is `GET /queue` for today (IST): a doctor's own patients, everyone's for other staff, optionally one clinic. `templates` are the doctor's own (empty for other roles). `serverTime` lets the app show how old its copy is.
- **Offline writes** (check-in, vitals, notes, tags, counter payments) are queued on the device and replayed through their normal endpoints with idempotency keys (§3o) when the network returns; signing, booking and online payments need a connection.
- **Audit:** `push_device.registered` (platform, app and whether it moved from another session) and `push_device.removed`. Revocations with a session are covered by that session's own audit entry.

## 3r. Patient account: consents and family

Implemented in Phase 2 (`apps/api/src/modules/portal`, PRD §4, §4.1). For the Patient app and the web portal; every endpoint is for the `patient` role only.

| Action | Endpoint | Who |
|---|---|---|
| Consents | `GET /portal/consents` → `{consents: [{kind, version, acceptedAt, withdrawnAt}], pending: [kind]}` | Patient |
| Accept | `POST /portal/consents {accept: [{kind, version}]}` → the same shape | Patient |
| Withdraw health data | `POST /portal/consents/health_data/withdraw` → the same shape | Patient |
| The account's patients | `GET /portal/patients` → `{data: [{id, uhid, name, dob, gender, language, relation, guardianPatientId}]}` | Patient |
| Add a patient | `POST /portal/patients {name, dob, gender, language?, guardianPatientId?}` → 201 the patient | Patient |

- **Account:** one phone number is one account, per organisation. Its patients are the records whose mobile is the number verified by OTP (`relation: account`: the person, or family sharing the number) and the dependants those records look after (`relation: dependant`). A record the clinic registered on that number is claimed simply by signing in; nothing has to be linked. Records of other numbers, and of other clinics, read as 404. Records merged into another one are left out; the kept record carries their history.
- **Consents:** `privacy_notice`, `terms` and `health_data`, each at the version in `CURRENT_CONSENT_VERSIONS` (`@dhc/contracts`); an older version is 409 with the kind in `fields`. Until all three are in force, health-data endpoints (`/portal/patients` and everything built on it) answer 403 `CONSENT_REQUIRED` with the missing kinds in `fields.consents`. Raising a version asks everyone again. Withdrawing health data closes those endpoints until it is accepted again; the privacy notice and terms are only withdrawn by closing the account (a data-rights request). Every acceptance and withdrawal stays on record.
- **Adding:** without `guardianPatientId` the record takes the account's number; with it, a dependant without a number, looked after by an `account` patient (not by another dependant). Name and date of birth already on the account are 409. New records get the next UHID and show at the clinic like any other.
- **Audit:** `consent.accepted` (kinds and versions), `consent.withdrawn` and `patient.created` with `source: patient_app`.

**Booking, appointments and prescriptions** (PRD §4.3, §4.4). All need the consents above and act only on the account's patients.

| Action | Endpoint | Who |
|---|---|---|
| What can be booked | `GET /portal/booking-options` → `{doctors, clinics, consultationTypes, horizonDays, cancelCutoffMinutes, maxActiveBookings}` | Patient |
| Slots | `GET /portal/slots?doctorId&clinicId&consultationTypeId&date` → as `GET /slots` with `channel=patient` | Patient |
| Book | `POST /portal/appointments {patientId, doctorUserId, clinicId, consultationTypeId, startAt, reason?}` → 201 the appointment | Patient |
| Appointments | `GET /portal/appointments` → `{upcoming, past}`, each `{id, patient, doctorName, clinicName, consultationTypeName, mode, date, startAt, startTime, tokenNumber, status, reason, canCancel, prescription}` | Patient |
| Cancel | `POST /portal/appointments/{id}/cancel {reason?}` → the appointment | Patient |
| Prescriptions | `GET /portal/prescriptions` → `{data: [{id, number, version, status, patient, doctorName, date, signedAt}]}` (signed, superseded and void versions) | Patient |
| PDF | `GET /portal/prescriptions/{id}/pdf` → the signed PDF (the copy stamped VOID once voided) | Patient |
| Test orders | `GET /portal/test-orders?limit&cursor` → `{data: [{id, patient, doctorName, visitDate, kind, name, region, side, views, notes, status, orderedAt, reviewedAt, results}], nextCursor}`; `POST /portal/test-orders/{id}/results` (the file as the body) → 201; `GET /portal/test-results/{id}/file` (§3t) | Patient |

- **What patients book:** active in-person consultation types that need no payment at booking. Online modes (identity check, telemedicine consent) and prepaid types (Cashfree) open with those features; until then they are 400 `consultationTypeId: not_bookable`.
- **Rules:** the slot must be open on the patient channel (horizon; inside the same-day cutoff is 409 `SLOT_TAKEN` with `startAt: cutoff`); no overbooking. A patient may hold `maxActiveBookings` upcoming bookings (409 `BOOKING_LIMIT`, `reason: active_bookings`), and `noShowLimit` no-shows within `noShowWindowDays` pause online booking (`reason: no_shows`). Bookings are `confirmed`, or `pending` for the front desk when `autoConfirm` is off; `source` is `app`. One patient's bookings are serialised, so a double tap cannot pass the limits twice.
- **Cancel:** booked (`pending` or `confirmed`) and at least `cancelCutoffMinutes` before the start; otherwise 409 (`reason: cutoff`, call the clinic). `canCancel` says so in advance.
- **Upcoming** is booked or in progress, today or later (IST), soonest first; everything else is past, most recent first. Rescheduled bookings show as their new appointment only.
- **Tests screen** (Patient app, `apps/mobile/src/patient/screens/tests.tsx`): the family's ordered tests, newest first, a page at a time with **Load more**, each with whose test it is, the label from `testOrderLabel` in the app's language, the visit date and doctor, the status (Ordered, Result uploaded, Reviewed) and the results so far (type, size, date, sent by the patient or added by the clinic). **Upload result** shows while the test is not reviewed and holds fewer than `MAX_RESULTS_PER_ORDER` results; the patient picks a PDF or a photo (`expo-document-picker`). Patients cannot read the clinic's upload settings, so before sending a file the app checks it against every upload type and, when the picker reports the file's size, the 25 MB ceiling; otherwise the server enforces the ceiling (413), and it always applies the clinic's limits. The answer replaces the row; each refusal above (409 `status: reviewed` and `file: too_many`, 413, 415 and 400 `file: type_not_allowed|too_large|type_mismatch|empty`, 429) has its own English and Hindi message, and after a 409 the app fetches the pages again (up to 20) so the row and its button match; a row it does not find is left as it is with the message. **View result** downloads `GET /portal/test-results/{id}/file` and opens it in the share sheet like a prescription PDF: one copy in its own folder (`test-results`) of the app's private cache, named `test-result-<n>.<ext>` (`pdf`, `jpg`, `png`, `heic` or `heif`) and nothing about the test, deleted when the share sheet closes (iOS) or, on Android, as the next result starts opening, even if that open fails, and on sign-out. Prescription PDFs use the same cache code in their own folder. The picker's copy of a file to upload (Android: `cache/DocumentPicker`; iOS: `tmp/<bundle-id>-Inbox`, taken as it is so no second copy is made) is deleted after the upload, a refusal or a failure, and both folders are emptied on sign-out. The app adds no audit events of its own.
- **Tests page** (web patient portal, `apps/web/app/app/tests/page.tsx`, and **Prescriptions**, `apps/web/app/app/prescriptions/page.tsx`): the same rules as the Patient app's screen, from the same code in `@dhc/api-client` (`patient-tests.ts`: when Upload result shows, the file checks against every upload type and the 25 MB ceiling, each refusal's message, the row after an upload or a 409, `test-result-<n>.<ext>` names). The upload is a file input behind the **Upload result** button, sent as the type checked (read from the file name when the browser gives none). Files are fetched with the bearer token in the header, never in a URL, and shown in a new tab from an object URL only when the type received is the one expected and is PDF, JPEG or PNG; anything else is saved. With pop-ups blocked the page offers a download link rather than saving unasked; object URLs are revoked when their tab closes, after a time limit and on sign-out, which also closes the portal's tabs (`apps/web/lib/patient-files.ts`). No API changes and no audit events of its own.
- **Audit:** `appointment.created` (`source: app`), `appointment.status_changed` (`source: patient_app`) and `prescription.pdf_viewed`, all under the patient's user ID; test orders as in §3t.

## 3s. Platform console

Implemented in Phase 3 (`apps/api/src/modules/platform`, PRD §3.2, §9.1, §9.3; ADR 0016), with the web console at `/platform` (`apps/web/app/platform`). For platform operators, who are not clinic users: organisations, doctor verification, usage and system health only, never patient or clinical data (threat model T17).

| Action | Endpoint | Who |
|---|---|---|
| Sign in | `POST /platform/auth/login` `{email, password}` → `{status: mfa_required, mfaToken}` → `POST /platform/auth/mfa/verify` `{mfaToken, code}` → tokens | Platform operator |
| Refresh / logout | `POST /platform/auth/refresh` `{refreshToken}` (rotates); `POST /platform/auth/logout` (ends this session) | Platform operator |
| Who am I | `GET /platform/me` → `{operator: {id, email, displayName}}` | Platform operator |
| Organisations | `GET /platform/organisations` → `{data: [{id, slug, name, status, createdAt, clinics: {active, total}, staff: {doctor, frontDesk, clinicAdmin: {active, invited, revoked}}, doctorVerification: {pending, verified}}]}` | Platform operator |
| Onboard | `POST /platform/organisations` `{name, slug, clinic: {name, address?, phone?}, admin: {identifier, displayName?}}` → 201 `{organisation, clinic, invite: {id, role: clinic_admin, identifier, expiresAt, inviteUrl}}` (link shown once); 409 `slug: taken` | Platform operator |
| Verification queue | `GET /platform/doctors?status=pending\|verified&cursor=` (default `pending`) → `{data: [{profileId, organisation, displayName, identifier, registrationNumber, council, qualifications, specialty, verification, submittedAt, verifiedAt, verifiedBy}], hasMore, nextCursor}` (200 a page, oldest first) | Platform operator |
| Verify | `POST /platform/doctors/{profileId}/verify` `{ticket, expected: {registrationNumber, council, qualifications, submittedAt}}` → the doctor, verified, with `alreadyVerified`; 409 `profile: changed\|verified` | Platform operator |
| Usage | `GET /platform/usage?from&to` (IST days, default the last 30, at most 366) → `{from, to, data: [{organisation, appointments, prescriptions, payments: {count, amountPaise}, messages, scribeMinutes}]}` | Platform operator |
| System health | `GET /platform/health` → `{checkedAt (when the checks finished), api: {version, uptimeSeconds}, database: {status: ok\|down, latencyMs, latestMigration}, queues: {status: ok\|down\|not_configured, items: [{name, waiting, active, delayed, failed}]}}` | Platform operator |

- **Separate audience:** platform tokens have their own JWT audiences (`dhc-platform`, `dhc-platform-mfa`) and signing key; clinic endpoints refuse them (401) and `/platform/*` refuses clinic tokens (401). Sessions last 8 hours and are checked on every request; refresh tokens are single-use with reuse detection, as for staff.
- **Sign-in:** password then authenticator code, both required; 5 wrong passwords or codes lock the operator for 15 minutes (429). Only a correct code resets the count, so knowing the password does not allow unlimited code guesses. Each code works once, even when two requests race with it, and a valid code never undoes a lock or a disable that lands at the same moment. Two refreshes racing with one refresh token count as reuse and end the session. Unknown email, wrong password and a disabled operator give the same 401. Rate-limited per address like clinic sign-in.
- **Operators** are created, disabled, enabled and given a new authenticator only with the `support-platform-operator` command shipped in the API build ([runbook](../runbooks/platform-operators.md)); there is no HTTP route for it. Creating one sets the password and enrols the authenticator at once; the code that confirms the authenticator cannot then be used to sign in.
- **Networks:** every `/platform/*` request, sign-in included, must come from `PLATFORM_ALLOWED_CIDRS` (comma-separated CIDRs or addresses, IPv4 or IPv6), else 403. An empty list (or one of separators only, which is refused) allows nobody, except under `NODE_ENV=test`; `*` allows everyone and is for local development only. Production refuses `*` and catch-all networks (`0.0.0.0/0`, `::/0`) at start-up, here and in `TRUSTED_PROXY_CIDRS`. Refused requests are logged, not audited, so refused traffic cannot fill the database. In production the client address is the `X-Forwarded-For` entry `TRUST_PROXY_HOPS` (default 1) from the right, and with `TRUSTED_PROXY_CIDRS` (the load balancer's subnets and, for the web app's session routes, clinic and console, the web servers') only when the connecting peer is inside them; entries the client wrote further left are ignored. Without `TRUSTED_PROXY_CIDRS`, set `TRUST_PROXY_HOPS=0` unless the API port can be reached only from the load balancer and the web servers, or anyone reaching it directly can claim an allowed address.
- **No clinical data:** the console reads across organisations only through database functions that return counts and doctors' registration details, as the `dhc_platform` role, which has no grant on any clinic table (ADR 0016). Doctors' email or mobile are masked. Writes into an organisation (onboarding, verifying) run inside that organisation under its row-level security.
- **Onboarding** (PRD §9.1 steps 1–2) creates the organisation, its first clinic and a join invite for the first clinic admin in one transaction; the admin completes it at `/invite` like any staff invite and then invites the doctors. A taken slug is refused before anything is created, the admin's account included.
- **Verification** has the same effect and audit entry as the support command: the profile is verified with `verifiedBy: "<operator email> (<ticket>)"` and `support.doctor.verified` goes into the clinic's audit log with the ticket, operator, registration number and the operator's ID. Only what the operator checked is verified: `expected` repeats the registration number, council, qualifications and `submittedAt` the queue showed, and if any of them changed since (even while the request runs), nothing changes and the answer is 409 `profile: changed`; reload the queue and check again. If another operator verified it at the same moment the answer is 409 `profile: verified`; a profile already verified before the request reads as `alreadyVerified: true`. The queue lists active doctors with registration details only (a profile with just a signing PIN is not in it), oldest submission first, 200 at a time (`?cursor=` the previous page's `nextCursor`). Changing the registration number or council (not other fields) moves `submittedAt` on and returns the profile to pending, verified or not.
- **System health** reports the API server that answered (its `APP_VERSION` and seconds since it started; each server behind the load balancer answers for itself), the database and the background queues. The database check runs a trivial query as `dhc_platform` and reads the last migration applied through `platform_latest_migration()` (ADR 0016); a failure or no answer within 2 seconds is `down` (its transaction waits at most 1 second for a connection, lasts at most 2 seconds and runs each statement for at most 1 second, then is rolled back and its connection returned, so repeated checks against a stuck database cannot use up the pool), with `latencyMs` and `latestMigration` null. That covers a database that fails or slows down after the request's sign-in check has passed: every console request first reads its session from the database, so a database that is fully down fails there and the request gets the usual error (500) instead of this report, and the page says the API or its database is not answering. The queues are the workers' BullMQ queues (`QUEUES` in `@dhc/contracts`, shared with `apps/workers`), counted with BullMQ's `getJobCounts` over a connection opened for each check: `waiting` includes prioritised jobs, `delayed` includes retries waiting out their backoff, and `failed` is the retained failed jobs: jobs that failed after every retry and were kept, which happens only when the producer enqueued them with the shared `DEFAULT_JOB_OPTIONS` (`apps/workers/src/queues.ts`, `removeOnFail: false`); jobs enqueued with other options may be removed when they fail and are then not counted. Production must set the API's `REDIS_URL` to the workers' Redis (`redis://` or `rediss://`); it is optional locally and in CI, where unset (or empty) the queues are `not_configured` with no items; if Redis refuses or does not answer within 1.5 seconds they are `down`. Otherwise a component that is down is reported, not answered with a 5xx. Counts only: no job ID, name or payload is read, and nothing about any organisation. The console checks when the page opens and on **Refresh**, never on a timer.
- **Usage** counts visits as the clinic dashboard does (rescheduled ones excluded), prescriptions first signed and not voided, and payments received, over IST days. `messages` and `scribeMinutes` are `null` until messaging and the AI scribe exist.
- **Audit:** platform-level entries with no organisation, naming the operator, so one operator's activity reads in one place: `platform.auth.login.succeeded|failed|locked` (locked also at the code step), `platform.auth.mfa.failed`, `platform.auth.refresh.reuse_detected`, `platform.auth.logout`, `platform.organisations.listed`, `platform.organisation.created|create_refused`, `platform.doctors.listed`, `platform.doctor.verified|verify_refused`, `platform.usage.viewed`, `platform.health.viewed` (with the database's and the queues' status; every check is one entry, like the other reads, since the page does not poll; written in a transaction with the check's limits; with the database answering, an entry that cannot be written fails the request with a 500 within those limits, as for the other console reads; with the database reported down the entry may not be written, so the view may not have been audited, and that is logged instead), `platform.operator.created|disabled|enabled|authenticator_reset|password_reset`. In the organisation's own log: `platform.organisation.created`, `clinic.created` and `staff.invite.created` (operator in the metadata), and `support.doctor.verified`.
- **Web console:** `/platform/login`, then `/platform` (organisations and onboarding), `/platform/doctors` (the queue), `/platform/usage` and `/platform/health` (system health). As for the staff dashboard (ADR 0015), the web app's own routes hold the refresh token in an httpOnly cookie, here `dhc_platform_session` on `Path=/api/platform-session` (`login`, `mfa`, `refresh`, `logout`, calling `/platform/auth/*`), and the page keeps the access token in memory; the clinic's `dhc_session` cookie is never sent to those routes, nor this one to the clinic's. 15 minutes idle signs out. Those four routes reach the API from the web server. By default the web server passes on no client address (`FORWARD_CLIENT_IP` unset), so the allowlist, rate limits and audit see the web server's own address for sign-in and refresh. With `FORWARD_CLIENT_IP=true` it passes on only the rightmost `X-Forwarded-For` entry, the one the load balancer wrote (Next.js fills the header in only when it is missing, so anything to its left is whatever the client sent). Before `FORWARD_CLIENT_IP` is turned on: the load balancer in front of the web servers must overwrite `X-Forwarded-For` with, or append to it, the client address it observed, so that address is the rightmost entry; the web servers must accept traffic only from the load balancer; and the API must believe forwarded entries only from the load balancer and the web servers. The API believes them only from a peer in `TRUSTED_PROXY_CIDRS` when that is set, so list both peers there: the load balancer's subnets (the console's own requests come from the browser through it) and the web servers' subnets (the web app's session routes, clinic and console). Each adds exactly one entry, so `TRUST_PROXY_HOPS=1` fits both paths. Without `TRUSTED_PROXY_CIDRS`, set `TRUST_PROXY_HOPS=0` unless the API port can be reached only from the load balancer and the web servers. Never add the web servers' addresses to `PLATFORM_ALLOWED_CIDRS`: that would open the console's sign-in steps to anyone who can reach the web app. (ADR 0015.) The console's other requests go from the browser straight to the API and are checked against the operator's address. The invite link from onboarding is shown once and never stored: it is held in the page's memory until dismissed (moving between console pages keeps it; a reload, closing the tab or signing out loses it), and meanwhile the idle sign-out waits (for up to an hour), the browser asks before a reload or closing the tab, and a second onboarding waits until it is dismissed. A scheduled refresh is retried (twice) only when the web server could not connect to the API at all (503 with `fields.api: unreachable`), since any other failure may already have rotated the refresh token; otherwise the session ends with a notice. Logout with an expired access token gets a fresh one from the cookie first, so the session never outlives its cookie.
- **Lost first-admin invite:** if the first clinic admin's link is lost or expires (72 hours) before they use it, nothing in the console or the support commands issues a new one: the slug is taken, so onboarding cannot be repeated, and `support-reset-authenticator` needs an active member. The clinic has no admin who could invite anyone. See the [operators runbook](../runbooks/platform-operators.md#lost-first-admin-invite) for what to do meanwhile.
- **Not built yet:** suspending an organisation; withdrawing a verification; re-issuing a first clinic admin's invite.

## 3t. Test orders and results

Implemented in Phase 3 (`apps/api/src/modules/orders`, PRD §7.1, §4.4), with the web patient profile and the Patient app's **Tests** screen (§3r). Partner lab booking (PRD: Phase 2) is not built.

| Action | Endpoint | Who |
|---|---|---|
| Catalogue | `GET /test-catalogue?q` → `{data: [{id, kind, name, regions, views}]}` (active tests, in the clinic's order; `q` filters by name) | Doctor |
| Manage the catalogue | `GET /test-catalogue/items` → `{data: [{id, kind, name, regions, views, active, sortOrder}]}` (every test, inactive too, in the clinic's order) | Clinic admin |
| Add a test | `POST /test-catalogue/items` `{kind, name, regions?, views?}` → 201 the test (`Idempotency-Key`, §3o) | Clinic admin |
| Edit a test | `PATCH /test-catalogue/items/{id}` `{name?, regions?, views?, active?}` → the test | Clinic admin |
| Reorder | `POST /test-catalogue/items/reorder` `{kind, ids}` → the whole list | Clinic admin |
| Write tests | With the draft: `PUT /appointments/{id}/prescription` `{…, tests: [{id, catalogueItemId, kind, name, region, side, views, notes}]}` (§3f) | The visit's doctor |
| A patient's tests | `GET /patients/{id}/test-orders?limit&cursor` → `{data: [{…order, appointmentId, visitDate, doctorName, reviewedByName, canReview}], nextCursor}` (ordered tests only, newest first; cursor pages as in §1, `limit` 1–100, default 50; an unreadable cursor is 400 `cursor: invalid`; the portal API's `GET /portal/test-orders` supports the same pagination, which the Patient app's **Tests** screen uses with **Load more**) | Doctor, front desk (no notes) |
| Results waiting | `GET /test-orders/awaiting-review` → `{count, data: [{id, kind, name, region, side, views, resultUploadedAt, visitDate, patient}]}` (the signed-in doctor's own orders, oldest result first, up to 50) | Doctor |
| Upload a result | `POST /test-orders/{id}/results`, the file as the body with its own `Content-Type` → 201 the order | Doctor, front desk |
| Review | `POST /test-orders/{id}/review` → the order | Doctor |
| Open a result | `GET /test-results/{id}/file` → the file | Doctor |
| Patient app and web portal (`/app/tests`; shared logic in `@dhc/api-client` `patient-tests.ts`) | `GET /portal/test-orders`, `POST /portal/test-orders/{id}/results`, `GET /portal/test-results/{id}/file` (§3r) | Patient |

- **Catalogue:** per organisation, seeded for every new organisation by a database trigger (and once for existing ones) with common blood tests, X-ray (20 regions; views AP, PA, Lateral, Oblique, Skyline, Standing), MRI (16 regions), CT (14 regions) and five others (urine routine, ECG, ultrasound abdomen, DEXA, nerve conduction). `kind` is `blood`, `xray`, `mri`, `ct` or `other`; only imaging has regions, only X-rays views. Clinic admins edit it (below).
- **Editing the catalogue** (clinic admin; other roles 403, another organisation's test 404; web: **Test catalogue** in the admin navigation). Names are trimmed with inner spaces made one, 1–120 characters, and unique per organisation among *active* tests in any case (409 `name: taken` when adding, renaming or reactivating; a retired name may be reused by a new test). Only imaging (`xray`, `mri`, `ct`) has regions: up to 40 (`MAX_CATALOGUE_REGIONS`), each 1–80 characters and listed once in any case; only X-rays have views, each once, from `AP`, `PA`, `Lateral`, `Oblique`, `Skyline`, `Standing` (`XRAY_VIEWS`). Shape errors are 400 with `fields.regions` or `fields.views`. The kind never changes (a `kind` in the edit is 400); add a new test instead. A clinic holds up to 300 tests, active or not (`MAX_CATALOGUE_ITEMS`; 409 `catalogue: full`). New tests go to the end. A reorder sends every test of one kind, active or not, each once, in the new order; the kind keeps the sort positions it had, so the other kinds stay put; a list that no longer matches is 409 `ids: stale` (reload). Nothing is deleted: orders point at tests, so a test is deactivated instead, and it drops out of `GET /test-catalogue` at once. Writes to one clinic's catalogue are serialised by an advisory lock. Edits never reach orders: an ordered test keeps its own kind, name, region, side and views, and draft lines are checked against today's catalogue only for what is new or changed (see **Writing**), so a renamed, edited or deactivated test never blocks an amendment or a draft save; a new line must use the test's current name, regions and views. The consultation screen still shows a stored region or view the clinic has dropped, marked "(no longer listed)". The database checks the same shape and limits and holds the partial unique index `(organisation_id, lower(name)) WHERE active`; the seeding function skips any name the organisation already holds in any case, active or not, and defers to that index on a race. Audited with no free text (no names, regions or views), like the price list and the medicine list: `test_catalogue.created` (kind, region and view counts), `test_catalogue.updated` (kind and the fields changed), `test_catalogue.activated` / `test_catalogue.deactivated` (kind), each with the test's ID as the entity (`test_catalogue_item`); and `test_catalogue.reordered` (kind, count, how many moved), whose entity is the clinic's catalogue (`test_catalogue`, the organisation ID); the audit log has a **Test catalogue** area.
- **An order** is `{id, catalogueItemId, kind, name, region, side, views, notes, status, orderedAt, resultUploadedAt, reviewedAt, results: [{id, mediaType, sizeBytes, uploadedAt, uploadedBy: patient|clinic}]}`. `side` is `left`, `right`, `both` or `na`; imaging only. The label is built by `testOrderLabel` in `@dhc/domain`: "MRI knee, right", "X-ray knee, both sides (AP, Lateral)". A result's `mediaType` is one of the five upload types (`UploadMediaType`).
- **Writing:** `tests` is the visit's whole list and replaces the draft's; leave it out to keep them (older clients). The client chooses each `id` (a random UUID; another visit's ID is 400). A new or changed catalogue test must be active in this clinic's catalogue with the same kind and name, a region from its list (imaging with regions needs one) and views from its list; otherwise 400 `tests: invalid`. Tests already ordered, and draft lines sent back unchanged, are not checked again. A draft line the visit already holds is checked only for what changed: with the same catalogue test, kind and name, its stored region and views stand, so changing only the side or notes saves even after the clinic renamed, narrowed or deactivated the test; a new region, or a view the line did not have, must be in today's list (and the test active); clearing the region or dropping views is never a new choice and is allowed unless the active test still lists regions (imaging with regions needs one). The consultation screen shows a stored region or view the clinic has dropped, or of a deactivated test, as "(no longer listed)", with an empty choice to clear a region the test no longer offers. So a catalogue edit never blocks an amendment or a draft. Free text (`catalogueItemId: null`) is any kind; shape rules (no region or side off imaging, views only on X-rays, each view once) are checked for both. Up to 20 tests. Writing follows the prescription: the visit's doctor, after check-in, while the latest version is a draft (409 `PRESCRIPTION_LOCKED` otherwise).
- **Ordering and locking:** signing names the tests the screen showed (`testIds`, §3i; 409 `tests: review` otherwise), then sets `orderedAt` (the signing time) and `prescriptionId` on the draft's tests. The database allows exactly that: a test cannot be inserted already ordered, and becomes ordered only by the visit's newest version, signed, at its signing time; from then on the API refuses any change (409 `PRESCRIPTION_LOCKED`, `fields.tests: locked`) and a database trigger refuses deleting it or changing anything but the status, its times and the reviewer. An amendment draft must keep the ordered tests unchanged and may add new ones, which its signature orders. A prescription may order tests without medicines. Voiding a prescription leaves its tests ordered (open decision).
- **Status** only moves forward: `ordered` → `result_uploaded` (and again with each further result) → `reviewed` (a doctor). A review is final: further uploads are 409 `status: reviewed` (a new result needs a new order), review needs an uploaded result (409 `status: ordered`) and is refused when already reviewed (409 `status: reviewed`). The database enforces the same: the status never moves back, the upload time is never cleared, a test becomes `reviewed` only from `result_uploaded` with a stored result, and a reviewed test does not change at all. Stored results carry only the five upload media types (a database check).
- **Uploads:** the request body is the file itself (no multipart), typed `application/pdf`, `image/jpeg`, `image/png`, `image/heic` or `image/heif`; other types are 415 and anything over 25 MB is 413 before the body is read in full. The clinic's settings (§3l) then apply through `checkUpload`, and the file's first bytes must match its declared type: 400 with `fields.file` = `empty`, `type_not_allowed`, `too_large` or `type_mismatch`. A body Fastify read as something else (JSON, text) is 415 `file: type_not_allowed`. A test holds at most 10 results (`MAX_RESULTS_PER_ORDER`), counted under the order's row lock: 409 `file: too_many` after that. Results come only from patients, the front desk and doctors (the database checks the role). Only ordered tests take results (a draft line is 409 for staff, 404 for patients). The file is stored by key (`organisations/<org>/test-results/<order>-<random>.<ext>`, no patient data, written once) with its SHA-256, and served only after the hash checks out, with its stored type, `X-Content-Type-Options: nosniff`, a sandboxing `Content-Security-Policy` and `Cache-Control: no-store`. Authentication and the role check run before the body is read (401 or 403 without buffering it). Staff and Patient app uploads share one limit of 60 per minute per address, counted before authentication. If recording the result fails after the file was stored, the file is removed again (failures to remove are logged). Malware scanning comes with the files module (threat model T12).
- **Access:** doctors read and review under the chart model (§3l; 403 `CHART_RESTRICTED`), and always for their own orders. The front desk lists tests without the doctor's notes and uploads, but cannot open files (403). Clinic admins have no access. Patients see and upload against ordered tests of the account's patients and the records merged into them (404 otherwise), after the consents (403 `CONSENT_REQUIRED`). Another organisation's orders and results are 404.
- **The doctor is notified in the app:** `GET /test-orders/awaiting-review` is the doctor's list of results waiting, shown on the web dashboard. No push or message is sent: the push sender does not exist yet (`pushTargets` only finds devices) and messaging is not built.
- **Audit:** `test_order.created` (visit, kind, whether from the catalogue), `test_order.updated`, `test_order.deleted` (draft lines), `test_order.result_uploaded` (result ID, media type, size, SHA-256, the uploader's role), `test_order.reviewed`, `test_orders.viewed` (a patient's list for staff, entity the patient; the Patient app list, entity the account, with `source: patient_app`; both with the count) and `test_result.viewed`; never test names, notes or file contents. The results-waiting list is a worklist like the queue and is not audited per view.

## 3u. Public doctor pages

Implemented for the public website (`apps/api/src/modules/public`, `doctors/`; Build Plan §5.1; ADR 0017), with the web page at `/doctor/[slug]` (`apps/web/app/doctor/[slug]`).

| Action | Endpoint | Who |
|---|---|---|
| Set the page | `PATCH /doctor-profile/public` `{slug?, listed?, about?, languages?}` (only the fields sent change; `slug` and `about` clear with `null`) → the doctor profile with `publicProfile: {slug, listed, about, languages, live}` | Doctor (own) |
| A page | `GET /public/doctors/{slug}` → `{slug, name, qualifications, specialty, registration: {number, council}, about, languages, organisation: {slug, name}, clinics: [{name, address}], consultationTypes: [{name, mode, durationMin, feePaise}], updatedAt}` | Public (120 per minute per address) |
| Sitemap | `GET /public/doctors` → `{data: [{slug, updatedAt}]}` (every page shown, by slug, at most 50,000) | Public (120 per minute per address) |
| Directory | `GET /public/doctor-directory` → `{data: [{slug, name, qualifications, specialty, organisationName, clinics: [{name, addressLine}], languages, feeFromPaise}]}` (every page shown, by name with a leading "Dr" title ignored, at most 500) | Public (120 per minute per address) |

- **Address:** lowercase letters, digits and single hyphens, 3–60 characters (typed values are trimmed and lowercased), not one of the reserved addresses (`admin`, `api`, `app`, `clinic`, `doctor`, `doctors`, `help`, `login`, `platform`, `robots`, `sitemap`, `support`, `verify`, `www`), unique across every organisation: `409 slug: taken`, without saying who holds it. A freed address can be taken by another doctor. Listing needs an address (`400 slug: required`, also when clearing the address of a listed page). `about` is up to 1000 characters (empty is none); `languages` up to 8 names of 1–40 characters, each once whatever the case, trimmed of any whitespace at either end. The database checks the same rules; a value it refuses that the contract let through is a 400 on its field.
- **Shown** only when listed, verified by the platform team, an active doctor in an active organisation with an active account. Every other address (missing, malformed, not listed, waiting for verification, suspended) is the same `404 NOT_FOUND` with message `Not found.`, never a validation error. `live` in the doctor's profile says whether the page is shown.
- **What a page holds:** only the fields above. The registration is the verified one; clinics and consultation types are the active ones the doctor has a schedule for that is in force today (IST) or starts later and has sessions (a stopped schedule is not shown), ordered by name and by fee. No internal IDs, contact details or anything about patients. Read without a user, as `dhc_app` with no organisation set, through the `public_doctor_profile`, `public_doctor_slugs` and `public_doctor_directory` database functions (ADR 0017).
- **Directory cards** (the home page's "Find a doctor"): the same doctors as the sitemap list, with only what their pages show: `clinics[].addressLine` is the first line of the clinic's address (carriage returns dropped, spaces and tabs trimmed, over 120 characters cut at a word with "…"; `null` when it is empty), from the same scheduled, active clinics as the page; `feeFromPaise` is the lowest fee of the scheduled, active consultation types (`null` when there are none). No registration, about text, organisation slug or IDs. The list is capped at 500 by name (a leading "Dr", "Dr." or "Dr " ignored, but not the "Dr" of "Drishti"); past that, the doctors last by name are not in it (their pages and the sitemap still are), and the API logs a warning. Searching happens in the browser over this list; the API has no search parameter.
- **Caching:** a shown page carries `Cache-Control: public, max-age=60, s-maxage=300` (a cached copy repeats the `x-request-id` of the request that filled it), the list and the directory the same, and a 404 `no-store`. The web home page `/` is rendered per request, the hero first and the directory in its own Suspense boundary; the directory comes from the web instance's fetch cache (300 seconds; after that a kept answer is still served while a fresh one is fetched in the background) and waits at most 3 seconds for the API. On a 429, failure or timeout with no kept list on that instance it shows "Doctor list unavailable, try again later"; failures are not kept, but a 200 the contract refuses is (until the next refresh). `PUBLIC_API_CACHE_SECONDS` (60–300, default 300) shortens how long the public pages keep the API's answers; below 60 only with the test-only `DHC_E2E=1` (the browser tests use 1), otherwise raised to 60 with a warning. The web page is regenerated at most every 300 seconds (ISR) and checks the address against the list (also cached 300 seconds) before asking for the page, so a page can take up to five minutes to appear or to go. A 429 or an API failure shows "busy, try again" on the web, not cached.
- **Booking:** the page's **Book an appointment** opens `/app/login?clinic=<organisation.slug>&next=/app/book?doctor=<slug>`. Booking options (`GET /portal/booking-options`) give each doctor's `publicSlug` when their page is listed and verified, and the portal's booking page picks the doctor from `?doctor=`; a `doctor` it does not know picks nobody and asks the patient to choose. A patient already signed in at another clinic than `clinic=` is asked to sign out first. Sign-in follows `next` only to pages under `/app` (never `/app/login`, another host or a protocol-relative address).
- **Audit:** `doctor_profile.public_updated` with `metadata.fields` naming what changed (`slug`, `listed`, `about`, `languages`), never the values; a save that changes nothing writes no entry. Page views are not audited (no actor, nothing changes).
- **Web home page:** `/` (`apps/web/app/(public)`): one line on what the platform is, **Patient sign-in** (`/app/login`) and **Clinic staff** (`/clinic/login`), and **Find a doctor**: a search over name, specialty, organisation, clinic name and the first line of its address (every word must match, case and punctuation ignored) and a specialty filter, with the number of results shown at once and announced (`aria-live`) once typing pauses for half a second, the sign-in links in a navigation named "Sign in", cards (each named "<doctor>: view profile and book") linking to `/doctor/<slug>` (with `?lang=hi` when the page is in Hindi) and "From ₹<fee>", and "No doctors listed yet" when the list is empty. English, or Hindi with `?lang=hi` or the toggle. Metadata: title, description, canonical, OpenGraph and `WebSite` JSON-LD.
- **Web sitemap and robots:** `/sitemap.xml` lists `/` and every page shown, from `GET /public/doctors`; `/robots.txt` allows `/` and `/doctor/` and disallows `/app`, `/clinic`, `/platform`, `/api`, `/display` and `/invite`.
- **Not built yet:** photos; per-organisation branding and custom domains (Build Plan §5.1); a clinic admin editing doctors' pages; choosing which clinics or consultation types a page shows.

## 4. Endpoint catalogue (by module)

| Module | Main resources and actions |
|---|---|
| identity | `/auth/*`, `/me`, `/staff/invites` (built), `/staff/members/{id}/sessions`, `/staff/members/{id}/sign-out-all` and `/staff/sessions/{id}/revoke` (built); `/me/devices` |
| tenancy | `/organisations/current`, `/clinics` (built), `/consultation-types` (built), `/booking-rules` (built), `/doctors` (built), `/organisation-settings` (built), `/branding`, `/tags` (built), `/uhid-settings` (built) |
| scheduling | `/availability/versions` (built), `/availability/exceptions` (built), `/slots?doctorId&clinicId&consultationTypeId&date&channel` (built), `/appointments` (book, walk-in, list, confirm, check-in, start, complete, cancel, no-show, reschedule; built), `/queue?date` (built), `/queue/stream` (SSE; built), `/display-screens` (built), `/display/board` and `/display/stream` (built) |
| patients | `/patients` (search by phone, name or UHID, filter by tag; register; built), `/patients/{id}` (demographics and family, each view audited; edit; built), `/patients/duplicate-check` (built), `/patients/{id}/tags` (built), `/patients/{id}/chart` and `/patients/{id}/allergies\|conditions\|medications` (built), `/patients/{id}/consents`, `/patient-merges` (ask, approve, reject; built) |
| portal | `/portal/consents`, `/portal/patients`, `/portal/booking-options`, `/portal/slots`, `/portal/appointments` (book, list, cancel), `/portal/prescriptions` and `/portal/prescriptions/{id}/pdf`, `/portal/test-orders`, `/portal/test-orders/{id}/results` and `/portal/test-results/{id}/file` (all built) |
| clinical | `/appointments/{id}/consultation` (built), `/appointments/{id}/vitals` (built), `/scribe/sessions`, `/assessments/forms`, `/assessments`, `/patients/{id}/ask-ai` |
| prescribing | `/medicines` (search; built), `/medicine-master`, `/drug-molecules` and `/medicine-requests` (clinic admin; built), `/prescription-templates` (built), `/appointments/{id}/prescription` (draft and lines; built), `/patients/{id}/last-prescription` (built), `/appointments/{id}/prescription/safety-actions` (built), `/appointments/{id}/prescription/preview\|sign\|amend\|void` (built), `/prescriptions/{id}/pdf` (built), `/verify` (public; built), `/doctor-profile` and `/doctor-profile/public` (built) |
| orders | `/test-catalogue`, `/test-catalogue/items` (clinic admin), `/patients/{id}/test-orders`, `/test-orders/awaiting-review`, `/test-orders/{id}/results`, `/test-orders/{id}/review`, `/test-results/{id}/file` (built, §3t; lines are written with `/appointments/{id}/prescription`); `/referrals`, `/attachments` |
| billing | `/price-list` (built), `/appointments/{id}/bill` (built), `/bills/{id}/payments` (counter payments; built), `/payments/{id}/receipt` (built), `/collections` (built), `/bills/{id}/payment-link`, `/bills/{id}/checkout-session`, `/refunds`, `/reports/reconciliation` |
| messaging | `/message-templates`, `/notifications`, `/inbox/threads`, `/inbox/threads/{id}/reply`, `/opt-ins`, `/delivery-log` |
| abdm | `/abha/create`, `/abha/link`, `/abha/{patientId}`, `/scan-share/qr`, `/care-contexts`, `/consents` (request, list, revoke), `/external-records` |
| platform | `/platform/auth/*`, `/platform/me`, `/platform/organisations` (list, onboard), `/platform/doctors` and `/platform/doctors/{profileId}/verify`, `/platform/usage`, `/platform/health` (all built, §3s); `/imports` (upload, map, dry-run, run) |
| public | `/public/doctors` and `/public/doctors/{slug}` (no sign-in; built, §3u) |
| audit | `/audit-log` (built, clinic admin, with filters), `/data-rights-requests` |
| reports | `/dashboard` (built, clinic admin) |
| files | `/uploads/presign` → client uploads to S3 → `/uploads/{id}/complete` (malware scan before visible); test results upload straight to the API for now (§3t) |
| webhooks | `/webhooks/cashfree`, `/webhooks/whatsapp`, `/webhooks/sms`, `/webhooks/abdm` (see `webhooks.md`) |

## 5. Business-rule responses worth knowing

| Code | When | Client behaviour |
|---|---|---|
| `SLOT_TAKEN` | Slot booked by someone else | Show next available slots |
| `BOOKING_LIMIT` | Max active bookings or no-show rule | Explain; offer to contact clinic |
| `SAFETY_BLOCK` | Unresolved block-level safety alerts | Show alerts panel |
| `SCRIBE_DRAFT_PENDING` | Signing with unaccepted AI sections | Jump to draft sections |
| `DOCTOR_NOT_VERIFIED` | Unverified doctor tries to sign | Show onboarding status |
| `PRESCRIPTION_LOCKED` | Edit after signing | Offer amendment |
| `SIGNING_UNAVAILABLE` | No signing service on this server (503) | Explain; signing waits |
| `PAYMENT_PENDING` | Online consult without confirmed payment | Resume Cashfree checkout |
| `CONSENT_REQUIRED` | Scribe or ABDM action without consent | Start consent flow |
| `PATIENT_MERGED` | Writing to a record merged into another (409, `fields.patientId`) | Open the kept record |
| `CHART_RESTRICTED` | "Own patients only" and the doctor has not seen the patient (403) | Explain; check the patient in to the doctor |

## 6. Change process
1. Change Zod schema in `packages/contracts`.
2. CI regenerates OpenAPI and client; web and mobile must compile.
3. Breaking change → new endpoint or `/v2`, never a silent change.
4. Update this guide if conventions or the catalogue change.
