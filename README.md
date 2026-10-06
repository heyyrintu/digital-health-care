# Digital Healthcare Platform

Production platform for Dr. Siddharth Gupta's clinic: a web app, a Patient app and a Clinic app (iPhone, iPad, Android) and one backend, built as a single TypeScript monorepo.

- **What to build:** [PRD v3.0 (Final)](docs/product/PRD-v3.0-Final.pdf)
- **How to build it:** [Build Plan — Web, iOS and Android](docs/product/build-plan.md)
- **All project documentation:** [docs/README.md](docs/README.md) (ADRs, API, data dictionary, safety rules, security, QA, runbooks, store pack, user guides)

**Status:** Phase 0 (Foundations) — monorepo, CI and app skeletons in place. Auth, tenancy with row-level security and the audit log are next.

## Repository layout

pnpm workspaces + Turborepo ([ADR 0001](docs/adr/0001-one-typescript-monorepo.md)). Apps never import each other; shared code lives in `packages/` (enforced by lint).

| Path                  | What it is                                                                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/api`            | Core API — Fastify modular monolith, REST under `/v1` ([ADR 0006](docs/adr/0006-fastify-modular-monolith-on-aws-mumbai.md))                                                                                        |
| `apps/workers`        | Background workers on BullMQ + Redis (messages, PDFs, webhooks, ABDM, imports, reconciliation)                                                                                                                     |
| `apps/web`            | Next.js: public site, `/app` patient portal, `/clinic` staff dashboard, `/platform` console, `/display/[clinic]` waiting room ([ADR 0002](docs/adr/0002-next-js-for-the-web-app.md))                               |
| `apps/mobile`         | Expo app that builds the Patient app and the Clinic app via `APP_VARIANT` ([ADR 0003](docs/adr/0003-react-native-with-expo-for-ios-and-android.md), [ADR 0004](docs/adr/0004-two-store-apps-from-one-codebase.md)) |
| `packages/contracts`  | Zod schemas — source of truth for the API, OpenAPI 3.1 and the client ([ADR 0007](docs/adr/0007-rest-and-openapi-with-zod-contracts.md))                                                                           |
| `packages/api-client` | Typed fetch client for web and mobile                                                                                                                                                                              |
| `packages/domain`     | Shared business rules (UHID, IST dates, money in paise)                                                                                                                                                            |
| `packages/safety`     | Safety rule catalogue SR-01–SR-22 and alert types — draft, needs clinical sign-off                                                                                                                                 |
| `packages/i18n`       | English and Hindi strings                                                                                                                                                                                          |
| `packages/tokens`     | Design tokens (colours, spacing, type) for web and mobile                                                                                                                                                          |
| `packages/config`     | Shared TypeScript and ESLint configuration                                                                                                                                                                         |

## Getting started

Requirements: Node 22 (`.nvmrc`), pnpm 10 (`corepack enable`), Docker for local Postgres and Redis.

```bash
pnpm install
cp .env.example .env
pnpm db:up                        # Postgres 16 + Redis 7 in Docker

pnpm --filter @dhc/api dev        # http://localhost:4000/v1/health
pnpm --filter @dhc/workers dev
pnpm --filter @dhc/web dev        # http://localhost:3000
pnpm --filter @dhc/mobile start:patient   # or start:clinic
```

The mobile apps use native modules, so run them in an Expo development build (EAS profiles `development-patient` / `development-clinic`), not Expo Go.

## Checks

```bash
pnpm check          # lint, typecheck, test and build every package (what CI runs)
pnpm format         # Prettier
```

CI (`.github/workflows/ci.yml`) runs the format check and `turbo run lint typecheck test build` on every pull request.

## Rules

- A pull request that changes behaviour updates the relevant document in `docs/` in the same pull request.
- Never put real patient data in the repository, tests, fixtures or logs. Use the synthetic personas in `docs/qa/test-plan.md`.
