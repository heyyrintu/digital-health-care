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
| Staff login | `POST /auth/login` `{organisation, identifier, password, role?}` → `{status: mfa_required \| mfa_enrolment_required, mfaToken, otpauthUri?}` → `POST /auth/mfa/verify` `{mfaToken, code}` → tokens |
| Refresh / logout | `POST /auth/refresh` `{refreshToken}` (rotates), `POST /auth/logout` (ends this session) |
| Who am I | `GET /me` → user, organisation, role |
| Biometric unlock | `POST /auth/device/unlock` with device-bound key signature *(not yet built)* |
| Device revoke | `DELETE /auth/devices/{id}` *(not yet built)* |
| Signing approval | `POST /prescriptions/{id}/sign` with biometric assertion or signing PIN *(Phase 1)* |

Rules:
- **Access tokens** are JWTs valid for 15 minutes, carrying user, organisation, role and session. Every request also checks the session is live, so logout or revocation takes effect immediately.
- **Refresh tokens** are opaque, stored only as SHA-256 hashes, and single-use: each refresh returns a new one. Replaying an old one ends the whole session (`auth.refresh.reuse_detected` in the audit log). Sessions last 30 days for patients and 12 hours for staff.
- **Patient codes:** 6 digits, valid 5 minutes, stored as an HMAC, 5 attempts per code, at most 3 codes per number per 10 minutes. Delivery goes through an `OtpSender`; in development `OTP_DELIVERY=log` prints the code (forbidden in production) until the SMS provider is chosen (decision O5).
- **Staff:** passwords hashed with scrypt; 5 wrong passwords or codes lock the account for 15 minutes. An authenticator (TOTP) is mandatory — the first sign-in returns an `otpauthUri` to enrol, confirmed by the first valid code. Each code works once.
- Unknown user, wrong password and no access in that organisation all return the same `401` message.
- Sign-in endpoints are rate-limited per IP (10 per minute by default).

## 4. Endpoint catalogue (by module)

| Module | Main resources and actions |
|---|---|
| identity | `/auth/*`, `/me` (built); `/me/devices` |
| tenancy | `/organisations/current`, `/clinics`, `/settings`, `/branding`, `/tags`, `/uhid-settings` |
| scheduling | `/availability/versions`, `/availability/exceptions`, `/slots?doctorId&mode&date`, `/appointments` (create, reschedule, cancel, check-in, no-show), `/queue?tab=&date=`, `/display/{clinicId}` |
| patients | `/patients` (search by phone, name, UHID; built), `/patients/{id}` (built; each view audited), `/families`, `/patients/{id}/allergies|conditions|medications|tags|consents`, `/patients/merge-requests` |
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
