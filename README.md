# Digital Healthcare Platform

Current delivery priority: finish the web version first. Native app development and builds are paused (owner update, 5 November 2026). See the latest priority update in [the build plan](docs/product/build-plan.md).

Production platform for Dr. Siddharth Gupta's clinic: a web app, a Patient app and a Clinic app (iPhone, iPad, Android) and one backend, built as a single TypeScript monorepo.

- **What to build:** [PRD v3.0 (Final)](docs/product/PRD-v3.0-Final.pdf)
- **How to build it:** [Build Plan — Web, iOS and Android](docs/product/build-plan.md)
- **All project documentation:** [docs/README.md](docs/README.md) (ADRs, API, data dictionary, safety rules, security, QA, runbooks, store pack, user guides)

**Status:** Phase 0 (foundations) and Phase 1 (core clinic on web) are done: a full simulated clinic day passes in the browser. Phase 2 (mobile apps) is in progress: the code for the Clinic app (queue, two-pane iPad layout, idle lock, offline check-in, consultation and signing) and the Patient app (onboarding and consents, family, booking, appointments, prescriptions, privacy) is merged; store builds and testing on real devices are next. See [build plan §9.1](docs/product/build-plan.md#91-phases-and-exit-criteria) for progress.

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
| `packages/ui-web`     | Design system components for web: shadcn/ui primitives and clinic components (staff shell, status chips, slot picker) from the approved demo                                                                       |
| `packages/ui-native`  | Design system components for the mobile apps: the same theme as React Native styles (light and dark), text, buttons, fields, notices                                                                               |
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

The seed prints an invite link for each demo staff account. Open it in the browser (with the API and web app running) to set a password and add an authenticator app; you land signed in on the clinic dashboard. Later, sign in at http://localhost:3000/clinic/login with clinic ID `demo-clinic`. Patients sign in with a mobile code (`OTP_DELIVERY=whatsapp` sends through Meta WhatsApp Cloud API; see [setup](docs/runbooks/whatsapp-otp.md); `OTP_DELIVERY=log` prints codes in development), on the web at http://localhost:3000/app/login?clinic=demo-clinic; its consents screen links to the documents at `PRIVACY_NOTICE_URL` and `TERMS_URL`, which production must set (without them the portal offers no way to accept the consents).

The mobile apps use native modules, so run them in an Expo development build (EAS profiles `development-patient` / `development-clinic`), not Expo Go. They call the API at `EXPO_PUBLIC_API_BASE_URL` (default `http://localhost:4000/v1`; on an Android emulator use `http://10.0.2.2:4000/v1`, and on a physical device the development machine's LAN address; preview and production builds refuse to build without it). The Patient app signs in with a mobile code and the Clinic app with password and authenticator, both with clinic ID `demo-clinic`; a link such as `dhc-patient://sign-in?clinic=demo-clinic` fills the clinic ID in. Onboarding links to the privacy notice and terms at `EXPO_PUBLIC_PRIVACY_NOTICE_URL` and `EXPO_PUBLIC_TERMS_URL`; release builds must set both.

## Checks

```bash
pnpm check              # lint, typecheck, unit tests and build every package
pnpm test:integration   # auth and tenant-isolation suites against TEST_DATABASE_URL
pnpm build && pnpm test:e2e   # browser tests (Playwright) against E2E_DATABASE_URL
pnpm format             # Prettier
```

CI (`.github/workflows/ci.yml`) runs on every pull request: the format check and `turbo run lint typecheck test build`; the integration suites against a Postgres service; a bundle of each mobile app (Patient and Clinic) for iOS and Android; and the browser tests, which start the built API and web app against their own Postgres and upload screenshots and traces when a test fails.

Browser tests live in `apps/e2e`. Each test creates its own clinic and invite links directly in the database, so tests are independent and can run in parallel. Locally, create the database once (`docker compose exec postgres createdb -U dhc dhc_e2e`) and install Chromium with `pnpm --filter @dhc/e2e exec playwright install chromium`.

## Claude Code mod

`tools/claude/dhc-steward` is a Claude Code mod for maintaining and building this repository against the build plan: a plan pane (`/dhc`), CI-equivalent checks (`/dhc-check`), an orchestrated next increment with builder and reviewer agents (`/dhc-next`), and guards for applied migrations and pushes to `main`. Install it with `/plugin install dhc-steward --marketplace heyyrintu/digital-health-care`; see [its README](tools/claude/dhc-steward/README.md).

## Rules

- A pull request that changes behaviour updates the relevant document in `docs/` in the same pull request.
- Never put real patient data in the repository, tests, fixtures or logs. Use the synthetic personas in `docs/qa/test-plan.md`.

## WhatsApp appointment messages

Web staff and patient controls, booking confirmations, one 24-hour reminder, STOP handling and delivery history are implemented behind `WHATSAPP_APPOINTMENTS_ENABLED=false` by default. Configure approved templates and credentials later using the [appointment messaging runbook](docs/runbooks/whatsapp-appointments.md). Public portal links require ordinary sign-in; Redis jobs contain only IDs.

Optional generic WhatsApp record notices are documented in [the record-notice runbook](docs/runbooks/whatsapp-records.md). They remain disabled until configured. Patient portal referral letters are available independently of outgoing messaging.

Optional online collection for existing bills is implemented with Cashfree. It stays off until each clinic's own merchant account, public HTTPS URLs and credentials are configured. See [setup and recovery](docs/runbooks/cashfree-reconciliation.md). Refunds and settlement reports are implemented behind separate flags; prepaid in-person web booking is also gated independently.

Cashfree refunds are implemented behind a separate `CASHFREE_REFUNDS_ENABLED=false` gate. Admins request partial/full refunds; verified successes generate an append-only refund entry and printable voucher without changing the original bill or receipt. Daily collections show gross receipts, posted refunds and net collection. Setup/recovery remains in [the Cashfree runbook](docs/runbooks/cashfree-reconciliation.md).

Cashfree settlement reconciliation is implemented behind `CASHFREE_RECONCILIATION_ENABLED=false` on API/workers: nightly rolling reports, durable retries, immutable snapshots and clinic-admin review at `/clinic/reconciliation`. It does not change financial ledgers or confirm bank credit. See [ADR 0023](docs/adr/0023-cashfree-settlement-reconciliation.md).

Prepaid in-person web booking is implemented behind `CASHFREE_PREPAID_BOOKING_ENABLED=false`: server-priced reservations, verified confirmation or clinic approval, safe expiry and late-payment review. Native/telemedicine checkout and automated payment messages remain pending. See [ADR 0024](docs/adr/0024-cashfree-prepaid-booking.md).

The web portal now has **Payments and receipts** for owned family bills, checkout recovery, original receipt printing/PDF saving and separate refund updates. Optional payment/receipt/refund WhatsApp availability notices use independent consent and `WHATSAPP_PAYMENTS_ENABLED=false`. See [ADR 0025](docs/adr/0025-patient-finance-and-whatsapp-notices.md) and [setup](docs/runbooks/whatsapp-payments.md).

## Web patient data rights

`/app/data-rights` provides private patient-facing downloads, tracked correction/erasure review and verified clinic-scoped account closure, including after health-data consent withdrawal. Clinic admins and assigned doctors review requests at `/clinic/data-rights`. See [ADR 0029](docs/adr/0029-patient-data-rights-and-clinic-account-closure.md) for retention, download limits and manual review boundaries. Native app work is paused; cloud DSC and AI are deferred. This is local implementation, not production acceptance.

## Web WhatsApp service inbox

`/clinic/inbox` provides encrypted clinic conversations, team/doctor handoff, explicit service consent and guarded reply recovery. `/clinic/message-templates` synchronizes the Meta catalog for admin review and enablement of approved static utility templates; authoring stays in Meta Manager. The feature defaults off until unique clinic/sender mappings and provider credentials are configured. See [ADR 0030](docs/adr/0030-clinic-whatsapp-inbox-and-template-catalog.md) and the [inbox runbook](docs/runbooks/whatsapp-inbox.md). This does not complete dynamic notification bindings, costing or production acceptance.

## Reviewed clinic session changes

`/clinic/session-operations` previews and atomically applies session cancellation, moves or delay estimates, with immutable recovery receipts. Financial/care exceptions remain unchanged for individual review; moved/cancelled source intervals close to new bookings and walk-ins. Optional generic appointment-consent notices default off until their approved template and worker are configured. See [ADR 0031](docs/adr/0031-reviewed-bulk-clinic-session-operations.md) and the [session-operations runbook](docs/runbooks/clinic-session-operations.md).

## Coolify client preview

The web deployment uses [docker-compose.coolify.yml](docker-compose.coolify.yml), with production Node images, a single HTTPS gateway, private PostgreSQL/Redis, persistent files and migration/health checks. Follow the [Coolify deployment guide](docs/runbooks/coolify.md) and [client demonstration guide](docs/product/client-preview-guide.md). Generate private deployment values with `node scripts/coolify-env.mjs https://preview.your-domain.com`; provider credentials can be added later. This preview keeps OTP, WhatsApp, payments and legal signing off and uses synthetic records with normal staff passwords and MFA. Native CI builds remain paused unless `ENABLE_NATIVE_BUILDS=true` is set as a repository variable.
