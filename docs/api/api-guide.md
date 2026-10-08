# API Guide

**Status:** Draft · **Owner:** Backend lead · **Source of truth:** `packages/contracts` (Zod) → generated OpenAPI 3.1 → generated typed client (`packages/api-client`).

This guide explains conventions and lists the endpoint catalogue by module. Field-level detail lives in the generated OpenAPI reference; do not duplicate it here.

## 1. Basics

| Item | Convention |
|---|---|
| Base URL | `https://api.<domain>/v1` (production), `https://api.staging.<domain>/v1` (staging) |
| Format | JSON, UTF-8; dates ISO 8601 in UTC (clients display IST) |
| Auth | `Authorization: Bearer <access token>` (short-lived) + rotating refresh token |
| Tenant | Derived from the token; never sent by the client. Platform console uses a separate audience |
| Idempotency | `Idempotency-Key` header required on retryable writes (check-in, vitals, notes, payments, bookings, uploads). Same key + same body → same result for 24 h |
| Pagination | Cursor based: `?limit=50&cursor=<opaque>`; response `{ data, nextCursor }` |
| Versioning | URL major version (`/v1`). Additive changes only within a version. Two latest mobile app versions must keep working |
| Rate limits | Per user and per IP; stricter on OTP, login, upload, payment endpoints. `429` with `Retry-After` |
| CORS | Only the web app's origin (`WEB_BASE_URL`, or the `CORS_ORIGINS` list) may call the API from a browser. No cookies; credentials are never allowed cross-origin |
| Real time | Web: Server-Sent Events `/v1/stream/queue`; mobile: WebSocket `/v1/ws`; scribe audio: WebSocket `/v1/scribe/stream` |

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
| Staff invite (invitee) | `POST /auth/invites/inspect` `{token}` → `POST /auth/invites/accept` `{token, password}` → `{status: setup_required, otpauthUri}` or `{status: confirm_required}` → `POST /auth/invites/complete` `{token, code}` → tokens |
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
| Booking rules | `GET /booking-rules`; `PUT /booking-rules` `{horizonDays, sameDayCutoffMinutes}` (defaults 30 and 60) | Read: all staff · change: clinic admin |
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
- **Actions and roles:** `confirm` (pending → confirmed; front desk, doctor, admin), `check_in` (pending/confirmed → checked in; on the day only; front desk, doctor), `start` and `complete` (checked in → in consultation → completed; the patient's own doctor only), `cancel` (needs `reason`; front desk, doctor, admin), `no_show` (after the slot starts; front desk, doctor). Anything else gives 409. Staff bookings are created confirmed; walk-ins are created checked in. Automatic no-show after the slot is planned (worker).
- **Reschedule** works on pending or confirmed bookings: the new appointment is checked like a fresh booking (its own slot may be the old one's), the old one becomes `rescheduled` and the two are linked (`rescheduledFromId` / `rescheduledToId`).
- **Audit:** `appointment.created`, `appointment.status_changed`, `appointment.rescheduled` (IDs, dates, statuses and source only; never reasons or patient details). Every status change is also kept in the appointment's history with who and when.

## 3d. Queue and waiting-room screens

Implemented in Phase 1 (`apps/api/src/modules/queue`).

| Action | Endpoint | Who |
|---|---|---|
| Queue | `GET /queue?date&doctorId&clinicId` → `{date, myOpd, booked, completed, closed, averageConsultationMinutes}` (date defaults to today, IST) | All staff |
| Screens | `GET /display-screens`; `POST /display-screens` `{clinicId, label}` → 201 with the `link` (shown once); `POST /display-screens/{id}/revoke` → 204 | Clinic admin |
| Screen board | `POST /display/board` `{token}` → `{clinicName, date, doctors: [{doctorName, nowServing, next}]}` | Public (the screen's token; rate limited) |

- **Tabs:** `myOpd` is the patient in consultation first, then checked-in patients — those with a "show first" tag (Emergency, Priority) ahead of the rest, then by check-in time; `booked` is pending and confirmed by time; `completed` is newest first; `closed` is cancelled, no-show and rescheduled. `averageConsultationMinutes` is the mean of the day's completed consultations (start to completion). The web queue refreshes every 15 seconds while visible; live push may replace polling later.
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

- **Access (PRD §3.2):** chart and notes are doctors' only, shared across the organisation's doctors (the "shared chart" model; "own patients only" is a later setting). Front desk records vitals; clinic admins have no clinical access. Every view and change is audited (`chart.viewed`, `allergy|condition|medication.added|removed`, `vitals.viewed|saved`, `consultation.viewed|saved`) with IDs, revisions and removal reasons only.
- **Chart entries** are never deleted: removing one keeps it with who, when and why, because past prescriptions were checked against it. `source: patient` marks patient-reported entries, shown as unverified (safety rule SR-21).
- **Vitals** are one set per visit. `PUT` replaces the whole set (readings left out are cleared), within plausible ranges (400 otherwise). BMI is worked out from weight and height. Allowed while the visit is pending, booked, checked in, in consultation or completed; 409 for cancelled, no-show or rescheduled visits.
- **Notes** (`chiefComplaint`, `symptoms[{text, duration}]`, `examination`, `diagnoses[{code, label}]`, `plan`, `privateNotes`, `testsAdvised`, `advice`) are stored as one document encrypted with AES-256-GCM (the field cipher); `followUpDate` stays in the clear for reminders. Only the visit's doctor writes, once the patient has checked in (409 before; 403 for another doctor). `revision` must match the stored one (0 for the first save) or the save gets 409 with `fields.revision = stale`, so a second tab cannot overwrite newer notes; each save returns the next revision. Diagnoses may carry an ICD-10 code (a starter list ships in `@dhc/domain`; the full code set comes from a licensed source) or be free text.
- **Locking:** once the visit's prescription is signed (next slices), `lockedAt` is set and notes and vitals give 409.

## 3f. Prescription builder

Implemented in Phase 1 (`apps/api/src/modules/prescribing`), with the safety engine (§3g) and signing (§3i).

| Action | Endpoint | Who |
|---|---|---|
| Medicine search | `GET /medicines?q` (2+ characters; name, generic name or composition; up to 20) | Doctor |
| Draft | `GET /appointments/{id}/prescription` → `{prescription, defaultLanguage, canEdit}`; `PUT /appointments/{id}/prescription` `{language, items, revision}` | Doctor (writing: the visit's doctor) |
| Repeat last | `GET /patients/{id}/last-prescription?before={appointmentId}` → `{last: {appointmentId, date, doctorName, items} \| null}` | Doctor |
| Safety answers | `POST /appointments/{id}/prescription/safety-actions` `{key, action: acknowledge\|override, reason}` → the updated safety summary | The visit's doctor |
| Templates | `GET /prescription-templates` (own); `POST /prescription-templates` `{name, items}` → 201 (same name replaces); `DELETE /prescription-templates/{id}` → 204 | Doctor |

- **Medicine master:** the platform's reference list (`organisation_id` null; the licensed drug database in production, a synthetic sample of generic products in development and tests) plus medicines the clinic adds. Row-level security shows each clinic the reference list and its own; separate write policies let it insert and update only its own, so a reference medicine can never be changed or taken over. Inactive medicines are left out of search and rejected on save (400).
- **Lines:** each has a client-chosen `id` (a random UUID, so edits keep it), `medicineId` (null for free text, shown as "not in the medicine list"), a snapshot of `name`, `composition` and `form`, `route`, `timing`, `steps[{dose, frequency, durationValue, durationUnit}]` (more than one step is a tapering course), `quantity`, `instructions` and `remarks`. Medicine IDs must be active and visible to the clinic (400 otherwise); line IDs must be unique; a step with a duration needs its unit.
- **Remarks:** unless `remarksEdited` is true, the server writes them from the steps, timing and route in the prescription's `language` (English or Hindi) with `dosageRemarks` from `@dhc/domain`, which the web app also uses for the live preview. Frequencies understood: slot patterns (`1-0-1`, with an optional fourth bedtime slot; when any amount is not 1, such as `2-0-2` or `½-0-½`, each slot is written with its own amount — "2 tablets after breakfast and 2 tablets after dinner"; a measured dose such as `500 mg` is repeated, "2 × 500 mg"), `OD`, `BD`, `TDS`, `QID`, `HS`, `SOS`/`PRN`, `STAT`, weekly, monthly and alternate days; anything else is printed as written.
- **Saving** follows the notes rules: only the visit's doctor, once the patient has checked in, with a matching `revision` (409 `revision: stale` otherwise); a signed prescription or locked consultation gives 409 `PRESCRIPTION_LOCKED` (an amendment draft stays writable). A save replaces the draft's lines. `defaultLanguage` is the patient's language. The view also returns `signingMissing` (what stops the visit's doctor signing apart from the safety alerts: `profile`, `verification`, `pin`, `service`), `canAmend` and `versions` (every version, newest first).
- **Repeat last** returns the patient's most recent prescription with lines (any doctor in the organisation) from a visit that started before `before` (the visit being written; 404 if it is not this patient's), or from any visit when `before` is omitted. Lines come without IDs; the client adds new ones.
- **Audit:** `prescription.viewed` and `prescription.last_viewed` record entity IDs only (the appointment, or the patient); `prescription.saved` adds the revision and line count; `prescription_template.saved|deleted` record the template ID, with the line count on `saved`. Never medicine names or remarks.

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
- **Not built yet:**
  - Clinic tuning of visibility for SR-06, SR-08 and SR-15.
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
- **Queue cards** carry `bill: {totalPaise, paidPaise, status} | null`.
- **Audit:** `price_list.created` (item ID and price) and `price_list.updated` (item ID, the fields changed and the new price when repriced), `bill.saved` (bill and visit IDs, revision, line count, total and discount), `payment.recorded` (bill ID, mode, amount, receipt number) and `receipt.viewed` (payment ID, receipt number). Never patient names.

## 3i. Signing, amendments and the QR check

Implemented in Phase 1 (`prescribing/signing.ts`, `doctors/`, PRD §6.6, §9.1, §9.4).

| Action | Endpoint | Who |
|---|---|---|
| Prescription pad | `GET /doctor-profile`; `PUT /doctor-profile` `{registrationNumber, council, qualifications, specialty, rxPrefix, paperSize}` | Doctor (own) |
| Signing PIN | `PUT /doctor-profile/signing-pin` `{password, pin}` → 204 | Doctor (own) |
| Preview | `GET /appointments/{id}/prescription/preview` → PDF marked PREVIEW (no number, signature or QR) | Doctor |
| Sign | `POST /appointments/{id}/prescription/sign` `{revision, pin}` → the signed prescription | The visit's doctor |
| Amend | `POST /appointments/{id}/prescription/amend` `{reason}` → 201, the new draft version | The visit's doctor |
| Void | `POST /appointments/{id}/prescription/void` `{reason, pin}` → the voided prescription | The visit's doctor |
| PDF | `GET /prescriptions/{id}/pdf` → the signed PDF, or after voiding the copy stamped VOID | Doctor, front desk |
| QR check | `POST /verify` `{code}` → `{status: genuine\|superseded\|void, number, version, latestVersion, signedAt, supersededAt, voidedAt, signatureMethod, doctor, clinicName, patient: {initials, ageYears, gender}, medicines}` | Public (30 per minute per address) |

- **Prescription pad:** registration number, council and qualifications are required, and the prefix (1–8 letters or digits, stored in capitals) is unique in the organisation (409 `rxPrefix: taken`). The platform team verifies the registration with the support command `support-verify-doctor` (runbook `doctor-verification.md`); changing the registration number or council sends the profile back to pending. Paper size is A5 or A4.
- **PIN:** six digits, set with the account password (400 `password: wrong`). It is hashed with scrypt after a server-keyed HMAC, so a database copy alone cannot be guessed offline. Five wrong PINs in a row pause signing and voiding for 15 minutes (429 `pin: locked`); a wrong PIN is 400 `pin: wrong`; no PIN is 422 `pin: unset`. PIN-checked requests share the sign-in rate limit per address.
- **Signing**, in order: the PIN (in its own transaction, so a wrong attempt counts); then under the visit lock the draft must have lines and the `revision` on screen (409 `revision: stale`); the doctor must be verified (403 `DOCTOR_NOT_VERIFIED`) with a complete pad (422 `profile: incomplete`); the safety check runs again and any open block or unanswered warning is 422 `SAFETY_BLOCK` with the counts. Then the number (the doctor's prefix and next running number, e.g. `SG-00042`; an amendment keeps its number), a random 24-character verification code, the PDF, its SHA-256 signed by the signer, and the file stored by key. The visit record (notes and vitals) locks. Without a signer the server answers 503 `SIGNING_UNAVAILABLE`.
- **Signer:** behind an adapter (ADR 0008). Until the cloud Class 3 DSC provider is chosen, `SIGNER=test_key` signs with an Ed25519 key derived from the server secret; the PDF, the record (`signatureMethod: test_key`) and the QR page all say it is not legally valid, and the setting is refused in production. The default is `disabled`.
- **PDF** (template `rx-1`, pdfkit): A5 or A4, black and white, labels in the prescription's language with Hindi shaped properly. It prints the doctor (name, qualifications, specialty, registration and council), the clinic, the patient (name, age, gender, UHID), the date, number and version, the consultation mode, the amendment reason, vitals, complaints, diagnoses, allergies, each medicine (name, generic in capitals, every step's dose, frequency and duration, remarks, instructions, quantity), tests, advice, follow-up, the signature block with the certificate, the QR with its link, and a disclaimer. Private notes are never printed. The same input renders the same bytes. Files are stored under a key, never a public URL (`FILE_STORE_DIR` until object storage), written once and never overwritten; a file that no longer matches its hash is refused.
- **Amendments:** a new draft version copying the lines (new line IDs), with the reason, writable after the visit record has locked. The signed version stays genuine until the amendment is signed, which marks it superseded.
- **Voiding:** only the newest signed version, with a reason and the PIN; not while an amendment draft is open (409). The signed file is kept unchanged; a copy with a notice page and every page stamped VOID is what the PDF endpoint returns from then on.
- **Immutability:** database triggers refuse any change to a signed version except becoming superseded or void (which touch only those fields), and any change to its lines or safety log. A locked visit record stays locked.
- **QR check:** the code goes in the body, not the URL, so it stays out of logs; it is looked up by its hash. The answer shows initials, never the patient's name.
- **Audit:** `prescription.previewed`, `prescription.signed` (version, number, PDF hash, signature method, template and drug data versions), `prescription.amendment_started`, `prescription.voided`, `prescription.pdf_viewed`, `doctor.profile_saved`, `doctor.signing_pin_set`, `doctor.signing_pin_locked`, `support.doctor.verified` (ticket and operator). Never medicine names or reasons beyond what is listed.
- **Not built yet:** delivery to the patient (app, WhatsApp, SMS link, email, ABDM) and notifying the patient of amendments and voiding (with messaging); the cloud DSC provider and PAdES signatures embedded in the PDF; biometric approval on the phone apps; a front-desk print button (the endpoint is ready); the platform console for verification.

## 4. Endpoint catalogue (by module)

| Module | Main resources and actions |
|---|---|
| identity | `/auth/*`, `/me`, `/staff/invites` (built); `/me/devices` |
| tenancy | `/organisations/current`, `/clinics` (built), `/consultation-types` (built), `/booking-rules` (built), `/doctors` (built), `/settings`, `/branding`, `/tags` (built), `/uhid-settings` (built) |
| scheduling | `/availability/versions` (built), `/availability/exceptions` (built), `/slots?doctorId&clinicId&consultationTypeId&date&channel` (built), `/appointments` (book, walk-in, list, confirm, check-in, start, complete, cancel, no-show, reschedule; built), `/queue?date` (built), `/display-screens` (built), `/display/board` (built) |
| patients | `/patients` (search by phone, name or UHID, filter by tag; register; built), `/patients/{id}` (demographics and family, each view audited; edit; built), `/patients/duplicate-check` (built), `/patients/{id}/tags` (built), `/patients/{id}/chart` and `/patients/{id}/allergies\|conditions\|medications` (built), `/patients/{id}/consents`, `/patients/merge-requests` |
| clinical | `/appointments/{id}/consultation` (built), `/appointments/{id}/vitals` (built), `/scribe/sessions`, `/assessments/forms`, `/assessments`, `/patients/{id}/ask-ai` |
| prescribing | `/medicines` (search; built), `/prescription-templates` (built), `/appointments/{id}/prescription` (draft and lines; built), `/patients/{id}/last-prescription` (built), `/appointments/{id}/prescription/safety-actions` (built), `/appointments/{id}/prescription/preview\|sign\|amend\|void` (built), `/prescriptions/{id}/pdf` (built), `/verify` (public; built), `/doctor-profile` (built) |
| orders | `/test-orders`, `/test-orders/{id}/results`, `/referrals`, `/attachments` |
| billing | `/price-list` (built), `/appointments/{id}/bill` (built), `/bills/{id}/payments` (counter payments; built), `/payments/{id}/receipt` (built), `/collections` (built), `/bills/{id}/payment-link`, `/bills/{id}/checkout-session`, `/refunds`, `/reports/reconciliation` |
| messaging | `/message-templates`, `/notifications`, `/inbox/threads`, `/inbox/threads/{id}/reply`, `/opt-ins`, `/delivery-log` |
| abdm | `/abha/create`, `/abha/link`, `/abha/{patientId}`, `/scan-share/qr`, `/care-contexts`, `/consents` (request, list, revoke), `/external-records` |
| platform | `/platform/organisations`, `/platform/doctors/{id}/verify`, `/platform/usage`, `/imports` (upload, map, dry-run, run) |
| audit | `/audit-log` (built, clinic admin; filters to come), `/data-rights-requests` |
| files | `/uploads/presign` → client uploads to S3 → `/uploads/{id}/complete` (malware scan before visible) |
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

## 6. Change process
1. Change Zod schema in `packages/contracts`.
2. CI regenerates OpenAPI and client; web and mobile must compile.
3. Breaking change → new endpoint or `/v2`, never a silent change.
4. Update this guide if conventions or the catalogue change.
