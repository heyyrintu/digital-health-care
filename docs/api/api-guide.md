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

## 4. Endpoint catalogue (by module)

| Module | Main resources and actions |
|---|---|
| identity | `/auth/*`, `/me`, `/staff/invites` (built); `/me/devices` |
| tenancy | `/organisations/current`, `/clinics`, `/settings`, `/branding`, `/tags` (built), `/uhid-settings` (built) |
| scheduling | `/availability/versions`, `/availability/exceptions`, `/slots?doctorId&mode&date`, `/appointments` (create, reschedule, cancel, check-in, no-show), `/queue?tab=&date=`, `/display/{clinicId}` |
| patients | `/patients` (search by phone, name or UHID, filter by tag; register; built), `/patients/{id}` (demographics and family, each view audited; edit; built), `/patients/duplicate-check` (built), `/patients/{id}/tags` (built), `/patients/{id}/allergies\|conditions\|medications\|consents`, `/patients/merge-requests` |
| clinical | `/consultations`, `/consultations/{id}/vitals`, `/scribe/sessions`, `/assessments/forms`, `/assessments`, `/patients/{id}/ask-ai` |
| prescribing | `/medicines` (search), `/prescription-templates`, `/prescriptions` (draft, update lines, `/safety-check`, `/sign`, `/amend`, `/void`, `/pdf`), `/verify/{code}` (public) |
| orders | `/test-orders`, `/test-orders/{id}/results`, `/referrals`, `/attachments` |
| billing | `/price-list`, `/bills`, `/bills/{id}/payment-link`, `/bills/{id}/checkout-session`, `/bills/{id}/counter-payment`, `/refunds`, `/receipts/{id}`, `/reports/collections`, `/reports/reconciliation` |
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
| `PAYMENT_PENDING` | Online consult without confirmed payment | Resume Cashfree checkout |
| `CONSENT_REQUIRED` | Scribe or ABDM action without consent | Start consent flow |

## 6. Change process
1. Change Zod schema in `packages/contracts`.
2. CI regenerates OpenAPI and client; web and mobile must compile.
3. Breaking change → new endpoint or `/v2`, never a silent change.
4. Update this guide if conventions or the catalogue change.
