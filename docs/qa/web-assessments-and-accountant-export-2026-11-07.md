# Web assessments and accountant export verification — 7 November 2026

Scope: ADR 0033 numeric assessments and the reconciliation CSV runbook. Development
branch only; these results do not claim a hosted deployment or provider acceptance.

## Passed

- All 53 migrations applied on fresh disposable PostgreSQL databases.
- 45 API integration tests across assessment, data-rights, tenant-isolation and settlement
  reconciliation suites. Coverage includes role boundaries, restricted charts, consent
  withdrawal, family and merged ownership, immutable/encrypted responses, concurrent
  submission/cancellation, stable-request retries, archived forms, bounded pagination,
  authentication/platform database privileges, owned ZIP contents and private CSV export.
- 25 lint/typecheck/unit-test tasks passed across the selected web/API/shared packages.
  Current unit totals: API 230, web 223, contracts 122 and translations 4. Dependencies'
  required type checks also passed.
- Three browser journeys passed against built local API/web: assessment builder,
  assignment, patient completion and repeated-score chart at 390px and 1280px; settlement
  reconciliation UI CSV download. The CSV UI uses the existing synthetic report fixture;
  real route data/permissions are separately exercised by integration tests.
- API build and Next.js production Webpack build passed. Root formatting and whitespace
  checks passed. Native development/builds remain paused.
- Inspected desktop doctor-history and phone patient-response screenshots with synthetic
  data. No real patient, email, payment or WhatsApp traffic was used.

## Remaining limits

The entire web backlog is not complete. Review-request consent/rules, EMR import, online
consultation and ABDM, confirmed/licensed clinical packs, remaining messaging/public-site/
platform capabilities and production hardening remain open in the maintained plan.
Questionnaires here are bounded numeric scales with raw totals, without diagnosis,
licensed scoring interpretation, branching/text questions, reminders or an automatic
response-correction workflow. CSV export does not reconcile bank statements or resolve
financial discrepancies. Real-host acceptance, backups/restore and provider activation
remain separate. No application deployment or MFA/provider configuration was changed.
