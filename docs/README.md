# Documentation Set — Dr. Siddharth Gupta Digital Healthcare Platform

Living documents for the build. Product scope is in **PRD v3.0 (Final)** and the delivery approach in the **Build Plan — Web, iOS and Android**. Exported copies are in `product/`; the editable masters stay in Claude Docs, so re-export after changing them. Everything here sits in the repository so it changes with the code.

**Rule:** a pull request that changes behaviour updates the relevant document in the same pull request.

| Document | Path | Owner | Update when |
|---|---|---|---|
| **PRD v3.0 (Final)** | `product/PRD-v3.0-Final.pdf` | Product owner | Scope changes (master copy in Claude Docs) |
| **Build Plan — Web, iOS and Android** | `product/Build-Plan-Web-iOS-Android.pdf` (+ `.docx`, `build-plan.md`) | Tech lead | End of each phase (master copy in Claude Docs) |
| Architecture decision records (ADR 0001–0028 + template) | `adr/` | Tech lead | Before a decision is implemented or changed |
| API guide and endpoint catalogue | `api/api-guide.md` | Backend lead | Every API change (reference itself is generated from OpenAPI) |
| Webhooks guide (Cashfree, WhatsApp, SMS, ABDM) | `api/webhooks.md` | Backend lead | Provider or event change |
| Data dictionary | `data/data-dictionary.md` | Backend lead | Every migration |
| Safety rule catalogue (clinical sign-off) | `safety/safety-rule-catalogue.md` | Product owner + clinical advisor | Any rule change |
| Threat model | `security/threat-model.md` | Tech lead | Quarterly, new integration |
| Data flows and record of processing (DPDP) | `security/data-processing-record.md` | Tech lead + lawyer | New data use or vendor |
| Vendor and DPA register | `security/vendor-register.md` | Product owner | Vendor change |
| Access control policy | `security/access-control.md` | Tech lead | Role change |
| Test plan | `qa/test-plan.md` | QA engineer | Each phase |
| Release checklist | `qa/release-checklist.md` | QA engineer | Each release |
| Runbooks | `runbooks/` | DevOps | After every incident or drill |
| Store submission pack | `store/store-submission-pack.md` | Product owner | Each store release |
| User guides and FAQ | `guides/` | Product designer | Each feature release |
| Release notes template and changelog | `release/` | Product owner | Each release |

## Status legend
Documents start as **Draft**. They become **Approved** when the named owner signs off in the pull request. Items marked `TBD` depend on open decisions in PRD §1.2.

## Data rule for all documents
Never paste real patient data (names, phone numbers, prescriptions, screenshots) into any document, ticket, test or prototype tool. Use the synthetic personas in `qa/test-plan.md`.

- [ADR 0023: settlement reconciliation](adr/0023-cashfree-settlement-reconciliation.md) — read-only provider reports, durable snapshots and clinic-admin acknowledgement.

- [ADR 0024: prepaid booking](adr/0024-cashfree-prepaid-booking.md) — atomic reservations, verified confirmation, safe expiry and late-payment review.

- [Current web-first requirements audit](reviews/web-plan-audit-2026-11-05.md) — full PRD/build-plan coverage, implementation evidence, gaps and remaining acceptance.

- [ADR 0025: patient finance and financial notices](adr/0025-patient-finance-and-whatsapp-notices.md) — authenticated dues/receipts, separate refunds and opted-in payment notices.

- [ADR 0026: patient web self-rescheduling](adr/0026-patient-web-self-rescheduling.md) — atomic family-owned replacement, clinic rules and interrupted-response recovery.

- [ADR 0027: patient profiles and verified phone changes](adr/0027-patient-profiles-and-verified-phone-changes.md) — protected family editing, private photos, doctor verification and scoped two-number proof.

- [ADR 0028: patient records and care retention](adr/0028-patient-records-sharing-and-retention.md) — batch/photo uploads, named-doctor links, explicit clinical use and durable unused deletion.

- [ADR 0029: patient data rights and clinic account closure](adr/0029-patient-data-rights-and-clinic-account-closure.md) — private downloads, tracked correction/erasure review and verified clinic-scoped account closure.

- [ADR 0030: WhatsApp inbox and template catalog](adr/0030-clinic-whatsapp-inbox-and-template-catalog.md) — encrypted clinic conversations, private handoffs, service-window authorization and provider template controls. [Activation and recovery](runbooks/whatsapp-inbox.md).

- [ADR 0031: reviewed bulk session changes](adr/0031-reviewed-bulk-clinic-session-operations.md) — atomic preview/apply, financial/care exceptions, source closures, delay estimates and consented generic notices. [Operator guide](runbooks/clinic-session-operations.md).

- [AWS ECS/Fargate hosting guide](runbooks/ecs.md) — client-preview architecture, AWS setup, image builds, persistent state, migrations, login and recovery without Coolify.

- [Hosted Meta WhatsApp OTP setup](runbooks/whatsapp-cloud-api-setup.md) — approved template, credentials, Coolify activation, callback configuration and patient-login acceptance.

- [Staff and platform second-factor options](runbooks/second-factor-auth.md) - deployment-owner choice of authenticator, WhatsApp OTP or password-only login.

- [Clinic People administration](runbooks/clinic-people.md) — searchable staff profiles, clinic roles/access, security and verified sign-in detail changes.
