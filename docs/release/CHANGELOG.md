# Changelog

All notable changes are recorded here, newest first. Format: version, date, summary, link to release notes.

## [Unreleased]
- Project set-up: monorepo, CI, environments (phase 0).
  - pnpm + Turborepo monorepo with apps (api, workers, web, mobile) and shared packages (contracts, api-client, domain, safety, i18n, tokens, config).
  - API skeleton: `/v1/health`, `/v1/openapi.json`, standard error shape, request IDs.
  - Workers on BullMQ; web route areas with security headers; Expo Patient/Clinic variants with EAS profiles.
  - CI: format, lint, typecheck, test and build on every pull request.
