# Web-first PRD and implementation audit — 5 November 2026

## Result and review boundary

**The complete planned web product is not finished.** Core clinic workflows and several integrations are implemented locally, but the remaining scope is substantially larger than payment links and receipts. Passing current checks does not satisfy all PRD acceptance criteria or establish production readiness.

This is a requirements-to-implementation coverage audit. It reads all 24 pages of `docs/product/PRD-v3.0-Final.pdf`, the maintained `docs/product/build-plan.md`, documentation/release/vendor/safety status, and compares requirements with registered API routes, database models, web pages/navigation, concrete provider adapters, active worker processors, CI definitions and relevant service/test implementations. An inventory covered 587 files across API source/tests, web, workers, shared packages and CI, excluding generated/vendor/build output. File inventory is not a claim that every line received a security review. Native application internals, external cloud/vendor accounts, fresh remote branch changes and production behavior were not audited in depth. Native development remains paused.

Review target: local branch `codex/meta-whatsapp-otp`, HEAD `4938c7a`, **including uncommitted working-tree changes**. Much of the recent WhatsApp/payment work is local; this report does not claim it is merged, remotely backed up, deployed or live. No PR, commit, deployment or external message/payment was made for this audit.

Current owner decisions take priority over the original PRD: web first; native work paused; Meta WhatsApp Cloud API directly; SMS/fallback deferred; credentials later; no PR. The PDF is the original product scope, the maintained Markdown records later delivery decisions, and ADRs 0018–0024 describe recent implementation boundaries.

## Status legend

- **Built locally:** substantive API/UI/business logic exists, with relevant automated coverage. This is not staging/pilot sign-off.
- **Partial:** some pieces exist, but specified workflow or acceptance behavior is missing.
- **Missing:** no implemented end-to-end path was found in registered modules/models/pages/workers. Names, comments, queue declarations and interfaces do not count as implementation.
- **External acceptance:** requires configuration, provider/account/policy decisions or a real sandbox/staging/clinic exercise.
- **Paused/deferred:** owner decision or explicitly post-launch/future scope.

## Patient web requirements (PRD §4)

| Requirement | Status and remaining work | Owning evidence |
|---|---|---|
| Phone sign-in, existing-record claim, EN/HI, consent versions, family/guardian records | Built locally. Meta transport is implemented; real delivery/approved authentication template still needs acceptance. | `apps/api/src/modules/auth`, `modules/portal/service.ts`, `modules/portal/account.ts`, `messaging/otp-sender.ts`; `apps/web/app/app/{login,family,consents.tsx}`; `portal.int.test.ts` |
| Complete profile: contact/emergency details, photo, patient-reported medical basics and verification | Partial. Family registration is not the full self-service profile and verification workflow. | `packages/contracts/src/portal.ts`; `modules/portal/routes.ts`; `apps/web/app/app/family/page.tsx` |
| Change phone with old/new OTP; lost-phone verification | Missing end-to-end patient/account workflow. Staff patient editing is not equivalent to verifying both numbers and migrating account access. | `modules/auth/routes.ts`, `modules/portal/routes.ts`, `modules/patients/routes.ts` |
| Notification preferences | Partial. Appointment/record WhatsApp opt-ins and STOP exist. Full event/category preferences, per-organisation sender/template administration and other channels do not. SMS remains owner-deferred. | `messaging/preferences.ts`, `messaging/webhooks.ts`; `apps/web/components/whatsapp-preference-card.tsx` |
| Data download, correction/erasure requests and account closure | Partial. Consent withdrawal and explanatory text exist; a tracked request workflow, patient export and account deactivation/retention handling are missing. | `modules/portal/service.ts`; `apps/web/app/app/privacy/page.tsx`; absence of a `DataRightsRequest` model/route |
| Home: next appointment and navigation | Built subset. Health snapshot, latest prescription/follow-up summary, payment shortcut and message center remain absent. | `apps/web/app/app/page.tsx` |
| In-person booking, configurable rules, limits and cancellation | Built locally; standard and prepaid web flows have concurrency/recovery coverage. | `modules/portal/booking.ts`, `payments/prepaid*.ts`; `apps/web/app/app/{book,appointments}`; `portal-booking.int.test.ts`, `prepaid-booking.int.test.ts` |
| Patient self-rescheduling | Missing. Staff rescheduling exists, but there is no portal rescheduling endpoint/page action. Moving a prepaid appointment is expressly blocked in ADR 0024. | `modules/appointments/routes.ts` versus `modules/portal/routes.ts` |
| Booking report attachments, calendar export and follow-up fee/eligibility review | Partial/missing as a patient booking journey. The current form provides a reason and standard fee, not all these capabilities. | `apps/web/app/app/book/page.tsx`; `packages/contracts/src/portal.ts` |
| Phone/video booking, identity, telemedicine consent and join details | Missing end-to-end. Consultation mode enums/safety checks do not implement an online-consultation workflow. | `modules/portal/booking.ts` restricts types to `in_person`; no identity/telemedicine consent entities/endpoints |
| Appointment lists and signed prescription history/download | Built locally. Full patient visit summaries and status timelines still need coverage against the PRD. | `modules/portal/booking.ts`; `apps/web/app/app/{appointments,prescriptions}` |
| General patient document upload/manage/share, reviewed badges and retention-aware delete | Partial. Test-result uploads and reading doctor-shared documents exist. They are not the full general-record upload/multi-file/used-document/share workflow. | `modules/portal/{orders,documents}.ts`; `modules/documents`; `apps/web/app/app/{tests,documents}` |
| Test orders and result upload | Built locally. Automated doctor notification of uploaded results is a separate remaining event. | `modules/orders`, `modules/portal/orders.ts`; `apps/web/app/app/tests`; `orders.int.test.ts` |
| Patient dues, receipt history/view/print | Missing complete portal journey. Public pay-only checkout and staff receipt printing exist; neither supplies authenticated patient receipt history or a dues list. | `payments/routes.ts`; `modules/portal/routes.ts`; `/pay/[token]` versus `/clinic/receipts/[id]`; no `/app/payments` or portal receipt routes |
| Messages, assessments, ABHA and ABDM/AI consent manager | Missing. See integration sections below. | No corresponding portal pages, models or active processors |

## Clinic operations, clinical and billing (PRD §§5–7)

| Requirement | Status and remaining work | Owning evidence |
|---|---|---|
| Patients, UHID, tags, duplicate checks/merges, staff registration | Built locally. Imported-UHID migration and verified lost-phone handling remain separate. | `modules/patients`; `apps/web/app/clinic/{patients,merges}`; patient/merge integration/browser suites |
| Availability versions, exceptions, slots, walk-ins, overbooking, status history, live queue and waiting-room display | Built locally. Live SSE and concurrency/history rules exist. | `modules/{scheduling,appointments,queue}`, `apps/api/src/live.ts`; clinic queue/availability/display pages and browser suites |
| Bulk session cancellation/reschedule with notifications; delay broadcasts | Missing end-to-end. Availability exceptions and individual appointment actions do not complete affected-booking bulk operations. | `modules/scheduling/routes.ts`, `modules/appointments/routes.ts`; limited outgoing notice kinds |
| Front-desk WhatsApp replies/inbox and reply-window controls | Missing. Current webhook processing handles delivery/STOP-related events, not a conversational inbox. | `messaging/webhooks.ts`, `apps/workers/src/processors.ts`; no thread model/inbox route/page |
| Clinical chart, allergies, conditions, medicines, vitals, encrypted notes, visit timing | Built locally. Full PRD context/speed acceptance and clinician confirmation are still required. | `modules/clinical`, `modules/appointments`; consultation/patient/vitals web screens and tests |
| Prescription builder, dosage remarks, templates, repeat last, amendments/void, PDF and QR verification | Built locally as workflows. Production signing has a separate blocker below. | `modules/prescribing`, `modules/doctors`, `packages/domain/src/dosage.ts`; signing/prescribing/verification suites |
| Safety checks and override audit | Implemented engine and tests; clinically approved licensed drug/Indian-brand data and sign-off remain external/implementation dependencies. | `packages/safety`, medicine/clinical/prescribing modules; `docs/safety/safety-rule-catalogue.md` remains Draft |
| Production cloud Class 3 DSC | Missing concrete provider adapter. The selectable implementation is `TestKeySigner` or no signer; test signatures are expressly labeled. Vendor selection/integration and real acceptance are required. | `apps/api/src/signing/signer.ts`, `apps/api/src/services.ts`; ADR 0008; vendor register |
| Orthopaedic specialty pack | Partial/unconfirmed. Generic templates, medicine entry and sided imaging orders exist; no complete clinically accepted ortho examination/diagnosis/advice/template pack was found. | consultation/prescribing/orders code; PRD §6.2 and owner decision O7 |
| Test catalogue, orders/results and reviewed status | Built locally. End-to-end result notification/acknowledgement remains broader than upload and review alone. | `modules/orders`; clinic test-catalogue and patient tests pages |
| Internal/external referrals, chart access, signed referral letter | Built locally, with test signing limitation. Recipient-doctor delivery/attachments are not established as complete by generic patient availability notices. | `modules/referrals`, portal referral routes, `messaging/record-links.ts`; referral suites |
| Clinic document library, sharing and portal viewing | Built locally for supported files; full S3/scanning/direct-upload plan is incomplete. | `modules/documents`, clinic library/documents cards, portal documents; document suites |
| Assessment form builder, scoring and trends | Missing. No form/response entities, APIs or screens. | model/route/page inventory |
| AI ambient/dictation scribe, consent, stream, transcripts, reviewed drafts and audio retention | Missing. Microphone permission in headers and queue names are not implementations. | no scribe module/model/processor/page; `platform/service.ts` reports scribe usage as null |
| Read-only Ask AI with record citations and consent/audit | Missing. Vendor choice and governed implementation are required. | no query model/API/UI/adapter |
| Google review requests, suppression/cooldown and sent/clicked metrics | Missing. Requires the workflow as well as a profile link and appropriate marketing opt-in/template. | no implemented review-request model/routes/processor/UI |
| Price list, bills, counter payments, numbered receipts and collections by mode/doctor | Built locally. | `modules/billing`; clinic bill/receipt/collections screens and suites |
| Cashfree existing-bill collection, verified callbacks/checks, refunds and vouchers | Built locally, separately gated. Merchant accounts/real callback and checkout/refund acceptance remain pending. | `payments/{service,refunds,routes}.ts`, `packages/cashfree`; ADRs 0021–0022 |
| Prepaid in-person booking | Built locally, gated, with safe release and late-payment review. Telemedicine payment, patient rescheduling and automatic refunds are not complete. | `payments/prepaid*.ts`, `modules/portal/booking.ts`; ADR 0024 |
| Settlement reconciliation and review | Built read-only reports/snapshots, nightly/manual execution and acknowledgements. Bank-statement matching, automated discrepancy resolution and CSV accountant export remain missing. Acknowledgement does not resolve balances/source flags. | `packages/reconciliation`, API/worker reconciliation, `/clinic/reconciliation`; ADR 0023 |
| Automatic payment-link/receipt/refund messages | Missing. Current links are manually shared; current record notices do not cover these financial events. | messaging schemas/worker dispatch and `payments` code |

## Messaging, ABDM, administration and website (PRD §§8–9)

| Requirement | Status and remaining work | Owning evidence |
|---|---|---|
| Meta OTP adapter, signed status callbacks, durable receipt processing and admin log | Built locally; credentials, approved templates and real Redis/provider smoke still require acceptance. | `messaging/otp-sender.ts`, webhook/delivery-log code, worker receipt processor; ADR 0018 |
| Appointment confirmation/24-hour reminder, record availability and authenticated record links | Built selected opted-in flows, disabled by default. Reschedule/cancel/2-hour reminders, delay, follow-up, result-request and other event coverage remain incomplete. | ADRs 0019–0020, messaging migrations and worker processors |
| Full per-org notification/template/sender administration, retries/cost reporting | Partial. One configured Meta sender transport and selected delivery statuses are implemented, not every organisation's complete template/channel setup and cost dashboard. Platform usage still reports messages as null. | worker/API config; `modules/platform/service.ts`; no complete template/thread/notification entities |
| SMS fallback, email and push delivery | Owner-deferred SMS; email transport and full push delivery remain missing. Device registration alone does not send notifications. | `modules/devices`, worker processor registration, vendor register |
| ABHA M1, Scan & Share and M2 HIP | Missing concrete models, APIs, adapters and screens; sandbox registration/review are also external dependencies. | model/module/worker inventory; no active ABDM processor |
| ABDM M3 external record retrieval | Post-launch scope, not a current completed feature. | PRD §8.3/§12.1 |
| Clinic administration and dashboard | Built subset: booking/clinic/type settings, tags/UHID, chart/safety/file settings, staff, medicine approval, audit, operational/collection totals. Data-rights/import/messaging cost/template administration remain incomplete. | settings/staff/patients/medicines/reports/billing routes; clinic cards/pages |
| Platform separate auth/IP controls, onboarding, doctor verification, usage and health | Built subset with no clinical access. Full go-live onboarding (HPR/certificate/cloud DSC/senders), message/scribe usage and suspension workflow remain incomplete. Suspension still depends on O8. | `modules/platform`; `/platform`; `packages/contracts/src/platform.ts` |
| Public doctor directory/profile, branding, booking handoff, SEO and verification | Built locally. Full embedded booking widget, doctor FAQs/maps/timing presentation and custom-domain operation need completion/acceptance against the detailed PRD. Current handoff goes into the portal. | `modules/public`; public home and `/doctor/[slug]`; `apps/web/lib/public-doctor.ts`, sitemap/verification routes |
| Current-EMR import wizard, mapping/dedup/dry run and historical records | Missing implementation. Real source export and parallel-run acceptance are also pending. | no ImportJob/model/module/page/worker handler |

## Production, security and quality requirements (PRD §§10–12; Build Plan §§4, 6–9)

| Requirement | Status and remaining work | Owning evidence |
|---|---|---|
| Tenant RLS, role boundaries, staff/patient/platform sessions, OTP/TOTP protections, audit and clinical field encryption | Substantial implementation and automated coverage. This audit is not an external penetration test or exhaustive endpoint authorization review. | `packages/db/src/client.ts`, migrations; auth/plugins/audit/field cipher; isolation and auth suites |
| Managed object storage, presigned uploads/downloads and malware pipeline | Missing production adapter/pipeline. `createServices` selects `LocalFileStore`. Existing content validation, image checks and bounded PDF rebuilds are meaningful safeguards but not the complete planned storage/scanning system. | `apps/api/src/files.ts`, `services.ts`, `modules/documents/content.ts`, `pdf-rebuild.ts` |
| Strict web CSP and security headers | Partial. HSTS/no-store/frame/referrer/permissions headers exist. No CSP configuration was found in the repository; a possible externally configured proxy/CDN header was not verified. | `apps/web/next.config.ts`; repository search for CSP/script-src |
| Payment endpoint throttling | Partial. Public pay/webhook limits and some check leases exist. No uniform route/account/provider throttling was found for every authenticated financial action; review as web hardening. | `payments/routes.ts`, `modules/portal/routes.ts`, `app.ts` (`global:false`) |
| Production secrets, TLS/India-region hosting and key management | Not established by repository defaults or `.env.example`. Requires actual deployment configuration/evidence; no secrets/accounts were inspected. | config/runbooks/vendor register; no deployment provisioning implementation found |
| Container/IaC/CI deployment, promotion and rollback | Missing repository implementation. Current CI checks/tests/builds; it does not build/promote container images or deploy AWS. No Dockerfile/Terraform source found. External infrastructure may exist and was not inspected. | `.github/workflows/ci.yml`, repository file inventory; deploy/rollback runbooks |
| Monitoring/error tracking, business usage/costs and restore drills | Partial. Structured logs, API health and queue probes exist. Production monitoring integration, uptime/load evidence, backup/restore execution and complete message/AI metering remain unverified or absent. | platform queue-health/health/service, logging config, backup/runbooks |
| PWA/offline front-desk web support | Missing installable manifest/service worker in current web source. Native offline logic is not a web implementation and stays paused. | web file inventory versus Build Plan §5.1/§6.4 |
| Accessibility, browser compatibility and performance targets | Partial evidence from components/local browser tests. No comprehensive axe/screen-reader/browser matrix, k6/10×-peak load run or measured p95/PDF/scribe/uptime sign-off established. | CI, e2e config, QA plan; absent load/accessibility runner configuration |
| Legal/policy/vendor/clinical acceptance | Pending acceptance of the PRD's listed product requirements, documents, clinical dataset and agreements; this audit does not determine current legal compliance. | PRD C1–C18; Draft vendor/safety/security documents; owner decisions O1/O3/O4/O7 |
| Full staging acceptance, pilot/parallel run and cutover | Open. A local simulated clinic-day test is not an actual staging acceptance exercise or two-week clinic pilot. | PRD §12.2/§12.5; build plan phases 4–5; release checklist |
| Native SDK/store/device acceptance | Paused, not web delivery work. Existing CI still defines mobile JavaScript bundle jobs; that is not evidence of store readiness. | owner decision; `.github/workflows/ci.yml` |

## PRD C1–C18 product-control coverage

This maps the controls stated by the PRD, rather than assessing their current legal sufficiency.

| PRD control | Implementation disposition |
|---|---|
| C1 patient identity for online consultation | Missing online identity workflow; online patient booking remains disabled. |
| C2 telemedicine consent | Missing dedicated consent and initiation workflow. |
| C3 doctor registration/council on prescriptions and website | Implemented fields/rendering/verification workflow; actual doctor data and production acceptance pending. |
| C4 telemedicine medicine categories | Implemented drug attributes and safety checks; clinical/licensed data acceptance and full online workflow pending. |
| C5 consultation mode recorded | Implemented in scheduling/appointments/prescriptions; patient online booking remains incomplete. |
| C6 recognised cloud DSC signing | Missing concrete cloud provider; test-key implementation does not satisfy this product control. |
| C7 clinical retention/non-deletion | Locked/immutable signed records and restricted access exist; complete retention lifecycle and operational evidence are not established. |
| C8 legible generic medicine names in PDF | Implemented prescription rendering and tests; clinician acceptance still required. |
| C9 purpose consents, rights, grievance and breach workflow | Partial: versioned health/privacy/terms consent and withdrawal exist. Rights/export/account closure and approved operational policies remain incomplete. |
| C10 verifiable guardian consent | Guardian relationships and age checks exist; they do not establish a complete verifiable guardian-consent workflow. |
| C11 SMS DLT registration | Owner-deferred SMS; not an implemented/passed control. |
| C12 store declarations and account deletion | Native/store work paused; tracked web account closure is also incomplete. |
| C13 ABDM registration, consent artefacts and review | Missing integration; external registration/review acceptance also pending. |
| C14 per-consultation ambient-recording consent | Missing with the scribe feature. |
| C15 governed AI vendors, regions and audio deletion | Vendor decisions/agreements and processing/retention implementation pending. |
| C16 Meta opt-in/templates/STOP | Selected opt-in/STOP/delivery workflows implemented; approved templates and live acceptance pending, broader event/sender management incomplete. |
| C17 AI drafts and safety override audit | Safety override audit exists; AI draft/acceptance workflow is missing. |
| C18 Cashfree-only online payment and published policy | Cashfree transport/verified receipts/refunds implemented locally with no app collection of payment credentials; real merchant acceptance and approved/published refund/cancellation policy still need verification. |

PRD reliability targets also remain acceptance targets: API p95 below 400 ms, PDF below 5 s, verified payment confirmation below one minute, clinic-hours uptime of 99.5%, backup recovery point of 15 minutes and recovery time of four hours. Source/unit tests and runbooks do not demonstrate these operating measurements or restore drills.

Explicitly exclude later/future scope from the current web completion claim: native/store delivery while paused, ABDM M3 post-launch, waitlists/white-label builds/partner-lab booking/body diagram as scheduled later, later subscriptions, and PRD non-goals such as inpatient management, insurance or OCR. Preserve the separate web telemedicine requirements without interpreting “no in-app video” as permission to omit external-call/video-link consultation workflows.

## PRD acceptance criteria (§12.2) disposition

1. Same-slot concurrency: automated local coverage exists; fresh staging acceptance remains open.
2. Allergy/interaction/child-weight/telemedicine-list safeguards: engine and local tests exist; licensed data/clinical acceptance remain open.
3. Signed immutability/amendment/QR: workflow implemented with test-key signing; full production DSC and amendment/void notification coverage remain incomplete.
4. Consented ambient scribe/draft timing/explicit acceptance: missing.
5. UPI payment → verified bill/one receipt: local synthetic coverage; real sandbox UPI, receipt delivery within one minute and full staging behavior remain open.
6. Online consultation cannot confirm unpaid/abandoned slot releases: only in-person prepaid flow is implemented. Uncertain holds deliberately retain slots until verified closure; this is not unconditional local-time release.
7. SMS fallback/actionable WhatsApp rescheduling: owner-deferred SMS; actionable rescheduling still missing. Do not mark passed.
8. Scan & Share and retrievable ABDM prescription after consent: missing.
9. Cross-organisation isolation: substantial automated evidence; full staging/security acceptance still open.
10. New-doctor complete onboarding in under an hour: implemented onboarding subset; real DSC/provider setup and timed acceptance still open.
11. Full clinic day on web/iPad/phone: local web simulation exists; real clinic staging sign-off open; native device acceptance paused.

## Plan drift and explicit decisions to retain

- Build Plan's older “Phase 0 done” wording overstates infrastructure/vendor readiness. The repository implements foundations in code, not all hosting, accounts and vendor exits.
- The previous 4 November branch audit is historical: PRs #39/#51 were subsequently integrated and WhatsApp/payment workers were subsequently implemented. Its old “only ping worker / no OTP adapter” statements are superseded.
- PRD specifies 48-hour default payment links and cancel-old-on-resend. Current ADR 0021 uses 30-minute checkout and protected original-order recovery; a dedicated resend/replacement lifecycle is not complete. Confirm intended product policy in acceptance rather than silently calling this identical to the original requirement.
- PRD's abandoned-payment release wording is broader than ADR 0024: uncertain orders retain reservations until verified closure; late payments require review/refund and never restore a released appointment. Preserve this safety boundary while documenting the user-visible behavior.
- PRD/older release checklist call SMS primary/fallback. The later owner decision is Meta WhatsApp-only for now; SMS is deferred, not implemented or passed.
- Patient rescheduling is not supplied by staff rescheduling. Test-result upload is not all patient record management. Status webhooks are not an inbox. Test signing is not a cloud DSC. Queue names are not active implementations.
- Credentials can be added later for built adapters. Missing S3/DSC/AI/ABDM/import/inbox code cannot all be solved by environment variables.
- Ordinary unit/build checks, targeted local integration/browser tests and provider sandbox/staging/clinical acceptance are separate evidence levels.
- No completion percentage is asserted: feature families differ greatly in size, and launch criteria are not a file-count calculation.

## Revised web-first work order

1. **Close the patient web payment journey:** authenticated dues/receipt history and print/download; opted-in WhatsApp payment-link and receipt/refund availability events; safe recovery and staff-visible exceptions. The earlier next-step list fits here, but covers only this slice.
2. **Close core patient/clinic web gaps:** self-service rescheduling with an explicit prepaid payment/refund policy, profile/contact verification, general record management and data-rights workflows; session cancellation/rescheduling and operational notifications; complete messaging inbox/preferences/template administration.
3. **Build production adapters/hardening alongside functional work:** S3/private upload lifecycle, appropriate scanning, selected cloud DSC and licensed drug-data integration, payment throttling/CSP/PWA requirements, deployment, monitoring and restore capability. Credentials and vendor decisions remain separate from local implementation.
4. **Finish remaining PRD web features:** assessments, review-link rules, clinically confirmed ortho pack, governed scribe/Ask AI, telemedicine identity/consents, ABDM M1/Scan & Share/M2, import wizard, onboarding/usage and remaining public-site/admin capabilities. Resolve existing vendor/policy dependencies before claiming delivery; M3 and explicit future non-goals remain separate.
5. **Perform complete web release acceptance:** full updated integration/browser matrix, accessibility/browser/performance/security checks, real Meta/Cashfree/DSC/ABDM staging acceptance where in launch scope, clinic rehearsal, migration/restore drill and pilot sign-off. No deployment or PR is authorized by this audit.

Native work resumes only at the owner's instruction. SMS stays deferred unless the owner changes that decision. Features not agreed for deferral remain open web requirements, rather than being silently dropped.

## Verification evidence and limits

Most recent local validation in this chat before the audit: **55 project check tasks passed**, **82 booking/payment integration tests plus 8 reconciliation integration tests passed**, and **7 browser tests passed** (prepaid/payment/refund/patient portal journeys). Fresh disposable PostgreSQL accepted all **41 migrations**. These are specific local validations, not all 41 API integration suites or all 32 browser spec files rerun after every change. No test suite was rerun merely for this documentation-only audit; no code changed during it.

The original PDF was extracted locally in full for requirements reading, and its scope/acceptance tables on pages 21–22 were visually checked; no legal update research or external vendor/cloud-account review was performed. The maintained plan and user decisions override older export wording where explicitly changed. Full source-line security review, deployed configuration verification and comprehensive staging acceptance remain outstanding.


## Subsequent implementation update — patient finance (5 November 2026)

ADR 0025 closes the audit's initial patient dues/receipt and financial-notice slice locally: owned bill/receipt history, exact-balance recovery, original receipt printing/PDF saving, separate refunds and independently opted-in payment/receipt/refund WhatsApp availability. Full browser coverage now passes 65 tests locally; 100 targeted financial/messaging integration tests and 52 scoped check tasks passed with 42 migrations. Real providers remain disabled/unverified. Treat the earlier rows as the audit snapshot and this entry as its financial-work status update. All other open requirements, external acceptance and native pause still apply.

## Subsequent implementation update — patient self-rescheduling (5 November 2026)

ADR 0026 adds authenticated family self-rescheduling for eligible unbilled/non-prepaid in-person appointments, with atomic linked history, clinic cutoff/availability rules, merged-history support and interrupted-response recovery. Billed/prepaid visits remain clinic-assisted. This updates the self-rescheduling gap only; the other open rows and staging acceptance remain outstanding.

Validation: all 42 API integration suites passed (594 passed, one Redis-dependent queue-health test skipped because TEST_REDIS_URL was not configured). After the final consultation-policy lock, 37 focused booking/prepaid/finance integration tests passed. The complete 66-test browser suite passed; interrupted-response rescheduling was additionally repeated at 390px and 1280px against the final API build (both passed). All 52 scoped web/API/worker/shared checks passed, followed by 16 API/browser check tasks after the safeguard. Formatting and diff checks passed. These are local synthetic checks; live-provider and deployment acceptance remain open.


### Owner update — defer cloud DSC and AI (5 November 2026)

The owner has deferred both cloud DSC provider selection/integration (O3) and AI speech/model provider selection/integration (O4) for now. Keep production cloud signing, ambient/dictation scribe and Ask AI outside the current work queue until resumed. Existing test-key signing remains a local/test capability; this deferral does not make it production DSC. The drug-database choice and clinical safety sign-off remain separate open items. Native app work and SMS remain paused/deferred under the earlier decisions.

Current web priorities: patient profile/contact verification; general patient record management; data-rights download/correction/account-closure workflows; conversational WhatsApp inbox and remaining notification/template administration; bulk clinic session operations; assessments/reviews and the confirmed specialty pack; import/accountant export; web telemedicine and ABHA/ABDM; production storage/scanning, deployment, monitoring, hardening and release acceptance. Patient dues/receipts, financial availability notices and eligible unbilled/non-prepaid self-rescheduling have been implemented locally and must not be counted as missing. Real Meta/Cashfree activation and sandbox checks follow when credentials are supplied. This is a delivery-order change, not a claim that deferred features are built or all launch criteria are met.

## Subsequent implementation update — patient profiles (5 November 2026)

ADR 0027 closes the core profile/contact/emergency/photo, unverified medical-basics and self-service old/new phone-verification slice locally. Doctor confirmation preserves the original patient report; canonical clinical data and signed history cannot be replaced through the profile form. Transfers are scoped to the selected adult/dependants in one clinic, with a normal new-number sign-in and consent checks. Lost-number in-person verification and existing-number collisions stay clinic-assisted; remote identity proofing and automatic account merging are not implemented. General records, data rights, inbox and the other open rows remain outstanding. Cloud DSC and AI are deferred by the owner.

Validation: all 43 migrations applied to fresh disposable databases; 128 affected API integration tests across eight suites passed; 52 scoped web/API/worker/shared checks passed; all 69 web browser tests passed, including clinic-side blood/allergy confirmation. After the final immediate-name refresh fix, 15 web/browser check tasks and both 390px/1280px profile/phone-change browser scenarios passed again. Formatting and diff checks passed. Real Meta delivery, production storage/scanning and staging acceptance remain separate.

## Subsequent implementation update — patient records (5 November 2026)

ADR 0028 adds the core patient-origin record journey: categorized batch uploads, combined photo PDF, owned appointment/order references, unused editing, named-clinic-doctor time-limited sharing, explicit review/use, used-record retention/hide/restore and durable unused-file deletion. Sharing is authenticated to a named clinic doctor and grants only the file, not a broader chart; anonymous/external sharing remains outside this increment. Current grantor consent and consent withdrawal close unused shares. Data-rights export/correction/account closure, automated record-upload notifications, production S3/scanning/backup controls and the other open requirements remain outstanding.

Validation: all 45 migrations applied to disposable databases, including grantor backfill; 72 affected API integration tests across five suites passed; all 52 scoped web/API/worker/shared checks passed; all 72 web browser tests passed. The new browser cases cover 390px/1280px combined upload/share/clinical-use/hide/restore and interrupted raw-upload recovery/deletion. Formatting and diff checks passed. These are local synthetic checks, not production storage/scanner, provider, backup or clinic acceptance.

### Patient data rights and clinic account closure — 5 November 2026

Implemented ADR 0029 locally: a consent-independent rights page; bounded private patient-facing ZIP downloads with owned merged history and file-integrity checks; encrypted correction/erasure-review requests with immutable events and revision-bound decisions; validated profile correction; clinical assignment/redaction and real correction evidence; policy-based retention review; and purpose-bound OTP clinic-account closure. Closure revokes current-clinic patient access/consents/preferences/shares, closes owned family profiles and queues eligible personal uploads/photos for deletion while preserving care/payment records and appointments. Ordinary sign-in/phone changes cannot reclaim closed profiles.

This closes the core self-service data-rights increment, not every formal/manual access or retention exception. Private clinician notes/drafts, oversized exports, identity disputes, reopening, clinical retention policy, production storage/scanning/backup erasure and release acceptance require clinic/operational work. Cloud DSC and AI remain deferred; native app work is paused. No PR or deployment was made. Next web increment: conversational WhatsApp inbox and remaining notification/template administration; the other open audit items remain open.

Validation: migration 46 applied to disposable databases; 91 affected API integration cases across six suites passed, including 13 rights cases covering closure retention, independent ZIP checks, erasure evidence, concurrency and India-calendar dates. All 52 scoped web/API/worker/shared checks passed; formatting/diff checks passed. All 74 web browser tests passed against the final build, including 390px/1280px rights flows. The dashboard range-change test now waits for the selected report before checking its metrics. These are synthetic local checks, not live Meta/Cashfree delivery, production infrastructure or clinic acceptance.

### WhatsApp service inbox and provider template catalog — 5 November 2026

Implemented ADR 0030 locally: immutable explicit clinic/sender/WABA routing, signed/deduplicated encrypted incoming text, unsupported-media placeholders, team and private doctor handoffs, read/resolve/reopen controls, explicit service-template agreement, STOP and clinic account-closure revocation. Replies use stable immutable intent IDs, keyed fingerprints, one-time authorization, service-window/permission/consent/template rechecks, bounded Meta calls, durable queued-intent recovery and uncertain-state handling without automatic resend. Signed status callbacks reconcile early and out-of-order results. English/Hindi web inbox and admin catalog support provider synchronization and explicit enable/disable of fresh approved static utility templates. Provider template creation/editing remains in the linked Meta Manager. No chart association or clinical authority is inferred from WhatsApp contact.

This closes the core conversational inbox and static service-template catalog slice locally. Dynamic/template notification bindings, full notification-event administration, provider-side authoring within this app, multiple simultaneous inbox numbers per clinic, costing, exceptional doctor-offboarding access, production transcript retention and live Meta acceptance remain open. Automated notification configuration remains separate. Native work stays paused, cloud DSC/AI stay deferred, credentials/mappings follow later; no PR, deployment or real external messages. Next web work can address bulk clinic session changes and operational notifications, with the remaining messaging administration backlog still visible.

Validation: all 47 migrations applied to fresh disposable databases; 72 affected API integration tests across five suites passed, including 15 inbox scenarios, account closure, tenant isolation and legacy WhatsApp/appointment regression. All 52 scoped web/API/worker/shared checks passed. The new 390px/1280px browser scenarios pass with an explicitly fake send/provider-availability fixture; they cover real authenticated inbox controls, template enablement, one-reply recovery and private doctor handoff. All 76 web browser tests passed on the final build. The clinic-day dashboard test now waits for the selected daily report before checking its tiles. After the final recovery-control adjustment, all 15 affected web/browser check tasks also passed; formatting and diff checks passed. Configuration tests reject reuse of the shared OTP/notification number as a clinic inbox sender. These checks do not activate or prove live Meta delivery, token scope/number registration/template approval, costing, retention or a production pilot.

### Reviewed bulk session operations and generic update notices — 5 November 2026

Implemented ADR 0031 locally: bounded frozen previews for one doctor/clinic/day interval, explicit confirmation/unchanged-exception acknowledgement, creator-bound atomic cancel/move/delay application, source/financial/clinical snapshot rechecks, checked target allocation, source availability closure and immutable stable-ID recovery receipts. Financial/prepaid/care-started bookings stay unchanged for individual review; there are no automatic refunds, bill transfers or doctor substitution. Explicit leave/holiday closures now also block new walk-ins. Delay estimates annotate today's waiting appointments in staff and patient views without moving booked times.

Optional additional generic WhatsApp update intents use appointment-category consent and a separate worker dispatcher. One-time authorization rechecks the applied source, current recipient/guardian/contact/consent, closure and expiry; callback-before-response preserves stronger status and unknown outcomes do not auto-repeat. The approved template receives only clinic name and portal-login URL. Default-off configuration and operator instructions are documented. Replacement booking confirmations/reminders remain independent; queued does not mean delivered.

This closes the reviewed core bulk-session/delay slice within its per-operation limits (200 source rows, 50 eligible changes, 15-minute preview). Multi-day campaigns, arbitrary per-patient auto-packing, bulk doctor substitution, financial/prepaid migration/refunds and broader notification-template/cost administration remain open/manual. Live Meta/Redis/provider/pilot acceptance and production infrastructure remain outstanding. Native work stays paused; cloud DSC/AI stay deferred. No PR, deployment or actual external message/payment was made. Next web priorities include assessments/review requests and the remaining confirmed specialty/import/online-consultation/ABDM and release requirements.

Validation: all 48 migrations applied to fresh disposable databases; 72 affected API integration tests across five suites passed, including 11 bulk-operation cases, individual appointments, prepaid booking, appointment notifications and tenant isolation. The operational receipt case was rechecked against the final build and preserves an early read callback. All 52 scoped web/API/worker/shared checks passed; formatting and diff checks passed. Both 390px/1280px browser scenarios pass for actual applied-response interruption/recovery, preserved bill, queued notice count and patient delay visibility. All 78 web browser tests passed on the final build. These are synthetic local checks, not live delivery or production acceptance.

## Coolify client-preview hosting follow-up

The owner prioritised hosting the current web progress for a client demonstration over further features. `docker-compose.coolify.yml`, the multi-target Dockerfile, private storage volumes, migration ordering, readiness probes, explicit synthetic bootstrap, preview banner, log limits, backup script, container verification workflow and deployment/demo runbooks are now implemented locally (ADR 0032). A worker runtime dependency issue and standalone web origin handling were corrected during container verification. The earlier "no deployment packaging" finding is superseded for the single-server synthetic preview. Real-patient launch, deferred providers and actual Coolify host acceptance remain open.

## Development follow-up — 7 November 2026

The audit's original assessment and accountant-export rows are superseded for these
bounded local implementations: fixed numeric questionnaires with doctor assignment,
consented family response, encrypted immutable answers, raw totals and same-form score
history/trends (ADR 0033); and private clinic-admin settlement/issue CSV exports from
complete reconciliation snapshots, with exact paise, formula protection and export audit.
These changes do not implement validated clinical scoring instruments, branching/text
questionnaires, review requests, bank-statement matching, import, online consultations,
ABDM or the other remaining development/acceptance requirements. They are development
branch work and have not been claimed deployed to the client-preview host.

### Review-request follow-up — 7 November 2026

ADR 0034 supersedes the core review-request gap: locally implemented neutral invitations,
independent consent and STOP, completed-visit/cooldown rules, durable single-send
authorization, provider tracking and explicit link-open counts. Clinic settings, public
Google destination validation, cancellation and owned data-export inclusion are covered.
Reviews remain optional; no star/text collection or posted-review claim is made.
Real Meta template approval/delivery and hosted acceptance remain separate. EMR import,
online consultations, ABDM and the remaining release work are still open; native apps,
cloud DSC, AI and SMS keep their existing paused/deferred status.

### Demographic import follow-up — 7 November 2026

ADR 0035 supersedes the missing demographic import wizard finding: mapped CSV upload,
immutable encrypted previews, duplicate validation, shared-contact warnings, source-ID
provenance, atomic confirmed creation and safe retry/re-upload are implemented locally.
Historical clinical/financial/document migration and real export/parallel-run acceptance
remain open; these cannot be treated as completed by a demographics-only import.
