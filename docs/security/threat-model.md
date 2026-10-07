# Threat Model

**Status:** Draft · **Owner:** Tech lead · **Review:** quarterly and before each new integration.

Method: list what we protect, who might attack or fail, where data crosses boundaries, and the control for each threat (STRIDE: spoofing, tampering, repudiation, information disclosure, denial of service, elevation of privilege).

## Assets
Patient identities and contact details; clinical records (notes, diagnoses, prescriptions, transcripts, audio, uploaded reports); signing authority (cloud DSC); payment status and Cashfree keys; ABDM consents and linked records; staff credentials and devices; audit log.

## Trust boundaries
1. Patient/staff device ↔ API (internet).
2. API ↔ data stores (private network).
3. API/workers ↔ third parties: Cashfree, WhatsApp provider, SMS provider, email, push (FCM/APNs), cloud DSC, drug database, speech-to-text and AI model, ABDM gateway.
4. Organisation ↔ organisation (tenant boundary inside our system).
5. Platform console ↔ clinic data (must be none for clinical content).

## Threats and controls
| # | Threat | STRIDE | Control |
|---|---|---|---|
| T1 | Staff account takeover (phished password) | S | Password + TOTP; device registration; biometric unlock; device revocation; anomaly alerts |
| T2 | Patient OTP abuse / SIM swap | S | OTP rate limits, short expiry, attempt lockout; sensitive actions need re-verification |
| T3 | Cross-tenant data access via ID guessing | I, E | Row-level security + API checks; 404 for foreign IDs; CI isolation suite |
| T4 | Public file URL leakage | I | Private buckets; signed URLs with short expiry; no PHI in file names |
| T5 | Forged payment webhook marks bill paid | T, S | Signature + timestamp verification, amount match, order status check with Cashfree |
| T6 | Duplicate webhook double-processing | T | WebhookEvent de-duplication; idempotent handlers |
| T7 | Prescription altered after signing | T, R | Immutability, PDF hash, DSC signature, QR verification, version chain, audit log |
| T8 | Unauthorised signing | S, E | Only verified doctors; biometric/PIN approval per signature; signing events audited |
| T9 | AI vendor retains or trains on data | I | DPAs with no-training clauses; approved regions; audio auto-deletion; minimum data sent |
| T10 | Prompt injection via uploaded documents into Ask AI | T, I | Ask AI read-only; answers cite sources; no tool access to write; output never auto-applied |
| T11 | Messages leak diagnosis on lock screens | I | Templates exclude diagnoses and medicine names; links require authentication |
| T12 | Malicious file upload | T | Type and size checks; malware scan before visibility |
| T13 | Lost or stolen clinic device | I | Idle lock, biometric unlock, remote revoke, encrypted local cache with limited scope |
| T14 | Insider misuse (staff browsing records) | I, R | Role-based access, chart model, audit of record views, periodic access review |
| T15 | API abuse / denial of service | D | WAF, rate limits, autoscaling, queue back-pressure |
| T16 | Secrets leaked in code or logs | I | Secret store, scanning in CI, no PHI or secrets in logs |
| T17 | Platform staff accessing clinical data | E | Platform console has no clinical endpoints; break-glass (if ever added) logged and time-limited |
| T18 | Data loss | D | Multi-AZ database, point-in-time recovery, monthly restore test |
| T19 | Attacker with a staff password enrols their own authenticator | S, E | Authenticators enrolled only via admin-issued invite links (single-use, 72 h, hashed, URL fragment, revocable); login never offers enrolment |
| T22 | A clinic admin takes over a staff account that also opens another clinic, via authenticator reset | E | Reset refused when the person is active staff elsewhere; those go to platform support ([runbook](../runbooks/support-authenticator-reset.md): callback plus clinic-admin confirmation, second-person approval, ticket, break-glass access), which audits the reset into every clinic the person works at (`support.authenticator.reset`) and revokes all their open links; no self-reset; reset ends every staff session and is audited (`staff.authenticator.reset`) |
| T21 | XSS steals web session tokens | S, I | Refresh token only in an httpOnly, SameSite=Strict cookie on `/api/session` (ADR 0015); access token in memory, 15-minute lifetime; session routes check Origin; no third-party scripts on clinical pages |
| T20 | Invite link intercepted | S | Link alone is not enough for an existing account (password + current authenticator); for a new account the admin sees acceptance in the invite list and audit log and can revoke; short expiry |

## Open items
- [ ] Pen-test scope agreed (web, both apps, API, tenant isolation, payment and webhook flows).
- [ ] Vendor security reviews for DSC, AI and WhatsApp providers.
