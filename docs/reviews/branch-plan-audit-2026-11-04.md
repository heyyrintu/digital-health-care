# Branch and build-plan audit

> **Merge follow-up, 4 November 2026:** PR #39 merged into main as `117045a`. PR #51 was updated with that main commit; its changelog conflict was resolved by retaining both entries. All combined checks passed in [run 41820313232](https://github.com/heyyrintu/digital-health-care/actions/runs/41820313232), including integration/tenant isolation, browser tests, build/unit checks and both mobile bundles. PR #51 then merged as `4938c7a`. The branch table and open-PR analysis below preserve the original pre-merge audit snapshot; these two PRs are now merged.

Snapshot: 4 November 2026 (India time).
Repository: https://github.com/heyyrintu/digital-health-care

## Repository synchronization

- Fetched all remotes and tags successfully. GitHub lists 19 branches; every branch is present locally and its local head matches its remote-tracking head.
- Created 18 missing local tracking branches. Existing local main already matches origin/main at 336cec49d15638d88ae0f1a1eb039b656a69271a.
- Current checkout remains rintu/tender-ptolemy-p8eleo at that same commit. This is a local-only branch with no additional work relative to main.
- No branches were merged, deleted or pushed. Latest main commit is dated 19 October 2026.
- Inspected all remote branch histories/diff areas, all 51 PR records, the maintained build plan, implementation boundaries, and all 249 available workflow runs. Open issues consist only of the two open PRs.

## Every branch

“Merged” means its listed feature PRs were merged on GitHub; it does not mean every planned product capability is finished. Older branch tips may predate subsequent fixes and must not be treated as current release candidates.

| Branch | Work | Delivery status | CI at exact branch head | PRs |
|---|---|---|---|---|
| `main` | Integrated baseline: core web clinic, mobile code, portal, public doctor pages, branding, tests and referrals. | Current integrated baseline | [Passed](https://github.com/heyyrintu/digital-health-care/actions/runs/39250625037) | — |
| `rintu/admiring-dijkstra-kerl4d` | Cross-clinic reference guards and tenant-isolation tests. | Merged; historical branch | [Passed](https://github.com/heyyrintu/digital-health-care/actions/runs/37753678587) | [#12](https://github.com/heyyrintu/digital-health-care/pull/12) |
| `rintu/busy-babbage-vn1t29` | Serialize queries sharing a database transaction. | Merged; historical branch | [Passed](https://github.com/heyyrintu/digital-health-care/actions/runs/37662371199) | [#8](https://github.com/heyyrintu/digital-health-care/pull/8) |
| `rintu/busy-fermi-myinf2` | Staff sign-in: preserve failed-code counts across logins and prevent authenticator-code replay races. | Open; not merged | [Passed](https://github.com/heyyrintu/digital-health-care/actions/runs/39252449790) | [#39](https://github.com/heyyrintu/digital-health-care/pull/39) |
| `rintu/clinic-app` | Clinic mobile queue, tablet two-pane layout, idle lock and offline check-in. | Merged; historical branch | [Passed](https://github.com/heyyrintu/digital-health-care/actions/runs/38843072297) | [#27](https://github.com/heyyrintu/digital-health-care/pull/27) |
| `rintu/clinic-app-api` | Push-device registration and offline cache API. | Merged; historical branch | [Passed](https://github.com/heyyrintu/digital-health-care/actions/runs/38632799280) | [#23](https://github.com/heyyrintu/digital-health-care/pull/23) |
| `rintu/clinic-app-consult` | Clinic mobile notes, vitals, prescriptions, safety alerts and signing. | Merged; historical branch | [Passed](https://github.com/heyyrintu/digital-health-care/actions/runs/38844062511) | [#31](https://github.com/heyyrintu/digital-health-care/pull/31) |
| `rintu/dreamy-wright-r29k6u` | Foundations and clinic workflows: patients, scheduling, queue, consultations, prescribing, safety, signing, medicines and patient merges. | Merged; historical branch | [Passed](https://github.com/heyyrintu/digital-health-care/actions/runs/38625737206) | [#21](https://github.com/heyyrintu/digital-health-care/pull/21), [#19](https://github.com/heyyrintu/digital-health-care/pull/19), [#17](https://github.com/heyyrintu/digital-health-care/pull/17), [#15](https://github.com/heyyrintu/digital-health-care/pull/15), [#14](https://github.com/heyyrintu/digital-health-care/pull/14), [#10](https://github.com/heyyrintu/digital-health-care/pull/10), [#7](https://github.com/heyyrintu/digital-health-care/pull/7), [#6](https://github.com/heyyrintu/digital-health-care/pull/6), [#5](https://github.com/heyyrintu/digital-health-care/pull/5), [#4](https://github.com/heyyrintu/digital-health-care/pull/4), [#3](https://github.com/heyyrintu/digital-health-care/pull/3), [#1](https://github.com/heyyrintu/digital-health-care/pull/1) |
| `rintu/dreamy-wright-r29k6u-docs` | Project documentation and build-plan decisions. | Merged; historical branch | No matching run found | [#2](https://github.com/heyyrintu/digital-health-care/pull/2) |
| `rintu/idempotency-and-live-queue` | Request idempotency and live queue updates using server-sent events. | Merged; historical branch | [Passed](https://github.com/heyyrintu/digital-health-care/actions/runs/38643571526) | [#25](https://github.com/heyyrintu/digital-health-care/pull/25) |
| `rintu/kind-mayer-olvjq3` | Earlier platform console, test orders, portal, public site, branding and referrals are merged; current increment is the document library and patient document sharing. | Open; not merged | [Passed](https://github.com/heyyrintu/digital-health-care/actions/runs/39305455423) | [#51](https://github.com/heyyrintu/digital-health-care/pull/51), [#50](https://github.com/heyyrintu/digital-health-care/pull/50), [#49](https://github.com/heyyrintu/digital-health-care/pull/49), [#48](https://github.com/heyyrintu/digital-health-care/pull/48), [#47](https://github.com/heyyrintu/digital-health-care/pull/47), [#46](https://github.com/heyyrintu/digital-health-care/pull/46), [#45](https://github.com/heyyrintu/digital-health-care/pull/45), [#44](https://github.com/heyyrintu/digital-health-care/pull/44), [#43](https://github.com/heyyrintu/digital-health-care/pull/43), [#42](https://github.com/heyyrintu/digital-health-care/pull/42), [#41](https://github.com/heyyrintu/digital-health-care/pull/41), [#40](https://github.com/heyyrintu/digital-health-care/pull/40), [#38](https://github.com/heyyrintu/digital-health-care/pull/38), [#37](https://github.com/heyyrintu/digital-health-care/pull/37), [#36](https://github.com/heyyrintu/digital-health-care/pull/36), [#35](https://github.com/heyyrintu/digital-health-care/pull/35), [#34](https://github.com/heyyrintu/digital-health-care/pull/34), [#33](https://github.com/heyyrintu/digital-health-care/pull/33), [#32](https://github.com/heyyrintu/digital-health-care/pull/32) |
| `rintu/mobile-foundation` | Shared native UI, secure mobile sessions and sign-in. | Merged; historical branch | [Passed](https://github.com/heyyrintu/digital-health-care/actions/runs/38644994648) | [#26](https://github.com/heyyrintu/digital-health-care/pull/26) |
| `rintu/modest-euler-npny0y` | Web design system, billing, admin dashboard, audit log, clinic settings and clinic-day acceptance test. | Merged; historical branch | [Passed](https://github.com/heyyrintu/digital-health-care/actions/runs/37877421898) | [#20](https://github.com/heyyrintu/digital-health-care/pull/20), [#18](https://github.com/heyyrintu/digital-health-care/pull/18), [#16](https://github.com/heyyrintu/digital-health-care/pull/16), [#13](https://github.com/heyyrintu/digital-health-care/pull/13), [#9](https://github.com/heyyrintu/digital-health-care/pull/9) |
| `rintu/patient-api` | Patient accounts, consents and family API. | Merged; historical branch | [Passed](https://github.com/heyyrintu/digital-health-care/actions/runs/38649942797) | [#28](https://github.com/heyyrintu/digital-health-care/pull/28) |
| `rintu/patient-app` | Patient mobile onboarding, family, booking, appointments, prescriptions and privacy. | Merged; historical branch | [Passed](https://github.com/heyyrintu/digital-health-care/actions/runs/38790092614) | [#30](https://github.com/heyyrintu/digital-health-care/pull/30) |
| `rintu/patient-booking` | Patient slots, booking, cancellation and prescription API. | Merged; historical branch | [Passed](https://github.com/heyyrintu/digital-health-care/actions/runs/38783822809) | [#29](https://github.com/heyyrintu/digital-health-care/pull/29) |
| `rintu/queue-followups-noshows` | Follow-ups queue and automatic no-shows. | Merged; historical branch | [Passed](https://github.com/heyyrintu/digital-health-care/actions/runs/38629073325) | [#22](https://github.com/heyyrintu/digital-health-care/pull/22) |
| `rintu/staff-device-signout` | Admin revocation of staff sessions and push devices. | Merged; historical branch | [Passed](https://github.com/heyyrintu/digital-health-care/actions/runs/38635152738) | [#24](https://github.com/heyyrintu/digital-health-care/pull/24) |
| `rintu/ui-web-screens` | Migration of web screens to the shared web UI package. | Merged; historical branch | [Passed](https://github.com/heyyrintu/digital-health-care/actions/runs/37725137328) | [#11](https://github.com/heyyrintu/digital-health-care/pull/11) |

Git ancestry alone gives misleading results for some older branches because their work was squashed into main. The merged PR records establish delivery; “ahead” commits on an old branch do not automatically represent missing features.

## Open branches requiring action

### PR #39 — staff sign-in protection

- Branch: rintu/busy-fermi-myinf2; head d329cb7b185f2c2480f99a5b991ec008bc83dde1.
- Contains main; 11 commits ahead, 0 behind; diff is 5 files, +132/-13 lines.
- Fixes failure-count reset before MFA completion and concurrent authenticator-code reuse/account-change races.
- The current main code still resets the count after password verification and uses an unconditional MFA update. This is an unmerged security fix, not merely a stale PR.
- GitHub reports mergeable=true and mergeable_state=clean. All five CI jobs passed, including integration/tenant isolation and browser tests.
- Recommended first integration candidate, followed by validation of the resulting combined code.

### PR #51 — documents and clinic library, part 1

- Branch: rintu/kind-mayer-olvjq3; head 3a951b53dec23c1cb26c70852ff74c5e7a85ece5.
- Contains main; 53 commits ahead, 0 behind; diff is 65 files, +8018/-70 lines.
- Implements clinic library management, reusable and one-off document sharing, patient portal Documents page, upload validation and bounded PDF rebuilding, contracts, migration, guides and tests.
- GitHub reports mergeable=true and mergeable_state=clean. All five CI jobs passed.
- Still outside this increment: WhatsApp/SMS/email delivery and notifications, mobile document screens, malware scanning, signed same-origin links (T27), unused-upload cleanup and a cross-organisation library. Hindi additions still need native-speaker review.
- PDF rebuild removes forms/values, links, bookmarks, attachments, comments and accessibility tags; the PR documents the tradeoff and server memory requirements.
- Mergeability and passing CI establish technical checks, not production approval. Neither open branch contains the other branch’s new feature; the combined result has not been validated by these independent CI runs.

Sources: [PR #39](https://github.com/heyyrintu/digital-health-care/pull/39), [PR #51](https://github.com/heyyrintu/digital-health-care/pull/51).

## What remains from the plan

| Phase | Evidence-based position | Remaining work |
|---|---|---|
| 0 Foundations | Core code and CI delivered; plan labels it done. | Production infrastructure/account readiness is not established by repository code. Only CI is implemented here; the deploy runbook describes future image promotion and ECS deployment. |
| 1 Core clinic web | Simulated clinic-day acceptance suite is merged; main CI passes. | Real cloud DSC provider, production storage and licensed drug data/clinical approval still need completion before production readiness. |
| 2 Mobile | Code is merged; deliberately parked under the web-first decision. | Store accounts, legal bundle IDs, EAS project configuration, push credentials, actual TestFlight/Play builds and doctor-day testing on phones/tablets. JS bundling in CI is not a signed store build or device acceptance test. |
| 3 Integrations and AI | Partially delivered. | Messaging cascade/inbox; real OTP delivery; Cashfree checkout/links/refunds/webhooks/reconciliation; ABDM M1, Scan & Share and M2; AI scribe; Ask AI; assessments; review links; import tool; organisation suspension after decision O8; custom domains/hosting; delivery of referrals and documents through messaging. Document library is only on open PR #51. |
| 4 Hardening | Plan says not started. | External security review and fixes, load/performance tests, accessibility, ABDM review, migration dry run, store submission/review. |
| 5 Clinic pilot | Plan says not started. | Production clinic deployment, parallel run, cut-over and two blocker-free weeks. |
| 6 Store launch | Plan says not started. | Public store releases, onboarding and subsequent ABDM M3 record fetching. |

Already integrated Phase 3 work includes platform console/operator auth, onboarding and doctor verification, usage/system health, test catalogue/orders/results, patient web portal, public doctor directory/pages, clinic branding and referral workflows with PDF/QR verification.

## Gaps confirmed in implementation

1. **Signing provider:** apps/api/src/signing/signer.ts implements TestKeySigner only. The cloud DSC interface exists, but createServices selects the test signer or null. Prescription/referral signing is therefore implemented as a workflow with a development/staging signing implementation.
2. **OTP:** apps/api/src/services.ts either logs a development code or throws “No OTP delivery configured.” No real SMS/WhatsApp sender is wired into the default services.
3. **Files:** apps/api/src/files.ts implements LocalFileStore; createServices defaults to it. A production S3 implementation is absent from the inspected source.
4. **Workers:** apps/workers/src/processors.ts registers only a system ping processor. Queue names and worker scaffolding do not constitute messaging, ABDM, imports or reconciliation implementations.
5. **Deployment:** .github/workflows/ci.yml checks/builds/tests and bundles mobile JavaScript, but does not build/push container images or deploy to AWS. No Dockerfile or Terraform files were found in the tracked source. The deployment runbook is not proof that hosting has been provisioned elsewhere.
6. **Clinical readiness:** docs/safety/safety-rule-catalogue.md remains Draft and explicitly requires clinical sign-off; the vendor register still lists drug data and cloud signing as TBD.
7. **Status drift:** README calls Phase 2 “in progress”; the maintained build plan explicitly parks mobile and prioritises web/Phase 3. Use the latter decision.

## Recommended sequence

1. Review/integrate #39, then integrate #51 after its document-handling tradeoffs and follow-ups are accepted; run checks on the combined result.
2. Establish real hosting/deployment, production object storage, monitoring/backups, cloud DSC and licensed drug data with clinical approval.
3. Choose messaging vendors and implement real OTP plus messaging delivery; this unblocks referral/document notifications.
4. Deliver Cashfree, then the remaining Phase 3 integrations in agreed product priority; resolve O8 before suspension.
5. Complete hardening and clinic acceptance, then the web-first pilot. Resume mobile store/device acceptance according to the maintained plan.

Outstanding owner decisions remain recorded as O1–O8: legal entity, team, DSC provider, drug/AI vendors, messaging providers, front-desk mobile scope, specialty/pilot date and suspension policy. Their external completion cannot be inferred from unchecked repository documents.

## Verification and limits

Main and both open branch heads have successful GitHub jobs for lint/typecheck/unit tests/build, integration and tenant isolation, browser tests, and both mobile app bundles. All other feature branch heads have a successful matching CI run except the documentation-only branch, where no matching run was found. This audit used existing exact-commit GitHub results; it did not rerun the entire suite locally, conduct a fresh line-by-line security review of every historical change, test real devices or inspect external AWS/vendor/store accounts.

Primary plan: [build-plan.md](../product/build-plan.md), especially §9.1 and §11.2. Other evidence: [CI workflow](../../.github/workflows/ci.yml), [vendor register](../security/vendor-register.md), [release checklist](../qa/release-checklist.md).
