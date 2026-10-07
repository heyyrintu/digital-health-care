# Digital Healthcare Platform

Production platform for Dr. Siddharth Gupta's clinic: a web app, a Patient app and a Clinic app (iPhone, iPad, Android) and one backend, built as a single TypeScript monorepo.

- **What to build:** [PRD v3.0 (Final)](docs/product/PRD-v3.0-Final.pdf)
- **How to build it:** [Build Plan — Web, iOS and Android](docs/product/build-plan.md)
- **All project documentation:** [docs/README.md](docs/README.md) (ADRs, API, data dictionary, safety rules, security, QA, runbooks, store pack, user guides)

**Status:** Phase 0 (Foundations) — monorepo, CI, auth (patient OTP; staff password + authenticator, set up through admin invite links), tenancy with Postgres row-level security and the audit log are in place. The tenant-isolation suite runs in CI.

## Repository layout

pnpm workspaces + Turborepo ([ADR 0001](docs/adr/0001-one-typescript-monorepo.md)). Apps never import each other; shared code lives in `packages/` (enforced by lint).

| Path                  | What it is                                                                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/api`            | Core API — Fastify modular monolith, REST under `/v1` ([ADR 0006](docs/adr/0006-fastify-modular-monolith-on-aws-mumbai.md))                                                                                        |
| `apps/workers`        | Background workers on BullMQ + Redis (messages, PDFs, webhooks, ABDM, imports, reconciliation)                                                                                                                     |
| `apps/web`            | Next.js: public site, `/app` patient portal, `/clinic` staff dashboard, `/platform` console, `/display/[clinic]` waiting room ([ADR 0002](docs/adr/0002-next-js-for-the-web-app.md))                               |
| `apps/mobile`         | Expo app that builds the Patient app and the Clinic app via `APP_VARIANT` ([ADR 0003](docs/adr/0003-react-native-with-expo-for-ios-and-android.md), [ADR 0004](docs/adr/0004-two-store-apps-from-one-codebase.md)) |
| `packages/db`         | Prisma schema, migrations and `withTenant` / `withAuth` — every request runs under row-level security ([ADR 0014](docs/adr/0014-tenant-isolation-with-postgres-row-level-security.md))                             |
| `apps/e2e`            | Browser tests (Playwright): invite page, web sign-in, staff invites and reset                                                                                                                                      |
| `packages/contracts`  | Zod schemas — source of truth for the API, OpenAPI 3.1 and the client ([ADR 0007](docs/adr/0007-rest-and-openapi-with-zod-contracts.md))                                                                           |
| `packages/api-client` | Typed fetch client for web and mobile                                                                                                                                                                              |
| `packages/domain`     | Shared business rules (UHID, IST dates, money in paise)                                                                                                                                                            |
| `packages/safety`     | Safety rule catalogue SR-01–SR-22 and alert types — draft, needs clinical sign-off                                                                                                                                 |
| `packages/i18n`       | English and Hindi strings                                                                                                                                                                                          |
| `packages/tokens`     | Design system theme (colours light and dark, fonts, radius) for Tailwind on web and as hex for mobile, plus spacing and type scales                                                                                |
| `packages/config`     | Shared TypeScript and ESLint configuration                                                                                                                                                                         |

## Getting started

Requirements: Node 22 (`.nvmrc`), pnpm 10 (`corepack enable`), Docker for local Postgres and Redis.

```bash
pnpm install
cp .env.example .env              # then fill JWT_SECRET and FIELD_ENCRYPTION_KEY (openssl rand -base64 32)
pnpm db:up                        # Postgres 16 + Redis 7 in Docker
docker compose exec postgres createdb -U dhc dhc_test   # once, for integration tests
pnpm db:migrate                   # apply migrations
pnpm db:seed                      # demo clinic, 3 staff invite links, synthetic patients

pnpm --filter @dhc/api dev        # http://localhost:4000/v1/health
pnpm --filter @dhc/workers dev
pnpm --filter @dhc/web dev        # http://localhost:3000
pnpm --filter @dhc/mobile start:patient   # or start:clinic
```

The seed prints an invite link for each demo staff account. Open it in the browser (with the API and web app running) to set a password and add an authenticator app; you land signed in on the clinic dashboard. Later, sign in at http://localhost:3000/clinic/login with clinic ID `demo-clinic`. Patients sign in with a mobile code (printed in the API console when `OTP_DELIVERY=log`).

The mobile apps use native modules, so run them in an Expo development build (EAS profiles `development-patient` / `development-clinic`), not Expo Go.

## Checks

```bash
pnpm check              # lint, typecheck, unit tests and build every package
pnpm test:integration   # auth and tenant-isolation suites against TEST_DATABASE_URL
pnpm build && pnpm test:e2e   # browser tests (Playwright) against E2E_DATABASE_URL
pnpm format             # Prettier
```

CI (`.github/workflows/ci.yml`) runs on every pull request: the format check and `turbo run lint typecheck test build`; the integration suites against a Postgres service; and the browser tests, which start the built API and web app against their own Postgres and upload screenshots and traces when a test fails.

Browser tests live in `apps/e2e`. Each test creates its own clinic and invite links directly in the database, so tests are independent and can run in parallel. Locally, create the database once (`docker compose exec postgres createdb -U dhc dhc_e2e`) and install Chromium with `pnpm --filter @dhc/e2e exec playwright install chromium`.

## Rules

- A pull request that changes behaviour updates the relevant document in `docs/` in the same pull request.
- Never put real patient data in the repository, tests, fixtures or logs. Use the synthetic personas in `docs/qa/test-plan.md`.
