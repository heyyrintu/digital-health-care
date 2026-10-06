# Changelog

All notable changes are recorded here, newest first. Format: version, date, summary, link to release notes.

## [Unreleased]
- Project set-up: monorepo, CI, environments (phase 0).
  - pnpm + Turborepo monorepo with apps (api, workers, web, mobile) and shared packages (contracts, api-client, domain, safety, i18n, tokens, config).
  - API skeleton: `/v1/health`, `/v1/openapi.json`, standard error shape, request IDs.
  - Workers on BullMQ; web route areas with security headers; Expo Patient/Clinic variants with EAS profiles.
  - CI: format, lint, typecheck, test and build on every pull request.
- Auth and tenancy (phase 0 exit criterion).
  - `packages/db`: Prisma schema and migrations for organisations, users, memberships, sessions, OTP challenges, patients and an append-only audit log; Postgres row-level security with `dhc_app` / `dhc_auth` roles (ADR 0014).
  - Patient sign-in by mobile code; staff sign-in by password + authenticator (TOTP) with first-login enrolment and lockout; rotating refresh tokens with reuse detection; logout takes effect immediately.
  - Staff patient search and view (each view audited); clinic-admin audit log.
  - Integration suite for auth and tenant isolation, run against Postgres in CI.
  - Development seed with synthetic personas.
- Staff invite links: clinic admins invite staff by email or mobile; the single-use link (72 h) is the only way to set a staff password and enrol an authenticator. Login no longer offers enrolment. Existing staff accounts confirm with their current password and authenticator. Seed now prints invite links.
- Web `/invite` page: checks the link, sets (or confirms) the password, shows the authenticator QR code and typed key, and confirms the first code; English and Hindi. The API now allows the web app's origin via CORS.
- Staff web sign-in: `/clinic/login` (password, authenticator code, role choice) and a signed-in `/clinic` dashboard with patient search and sign-out. The refresh token stays in an httpOnly cookie behind the web app's `/api/session` routes; the page keeps only the 15-minute access token. Reloads keep the session; 15 minutes idle signs out. Completing an invite now signs the person straight in (ADR 0015).
- Authenticator reset: clinic admins see their staff on the dashboard and can reset someone's sign-in. Reset clears the password and authenticator, ends all their staff sessions and issues a single-use reset link; the person sets new ones on `/invite` and keeps their role. No self-reset; staff who also work at another clinic need platform support (threat model T22).
