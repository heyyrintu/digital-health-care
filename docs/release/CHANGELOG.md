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
