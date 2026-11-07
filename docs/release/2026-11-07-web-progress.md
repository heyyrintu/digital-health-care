# Web progress release — 7 November 2026

Prepared from `ad614fbe34b521bb03c9b1f50dfa7fe1336d816c` (People administration, PR 54).
Release source: `codex/web-online-consultations`. Hosting target: existing synthetic client
preview at `https://dhc.drsiddharthguptaortho.in`, managed by Coolify.

## Included behavior

- Numeric assessment form publishing, doctor assignments, consented family responses,
  encrypted results and same-form history/trends.
- Clinic-admin accountant CSV exports from complete reconciliation snapshots, including
  exact paise and spreadsheet formula protection.
- Optional review requests: separate opt-in/STOP, completed-visit eligibility, cooldowns,
  one-send authorization, private invitations and deliberate link-open tracking.
- Patient demographic CSV import: mapped 100-row dry runs, duplicate checks, legacy
  source IDs/UHIDs, atomic confirmation, immutable provenance and safe retry/re-upload.
- Web online consultations: clinic-controlled non-prepaid audio/video booking, identity/
  guardian declarations, explicit consent, assigned-doctor checks, private external call
  details, join authorization windows and withdrawal. Used appointment modes are preserved.

Historical clinical import is owner-deferred. AI, cloud DSC, native apps and SMS retain
their paused/deferred status. No live provider activation or real-patient launch is implied.

## Database and configuration

Five forward migrations add assessments, review requests, demographic import provenance,
online-visit evidence and used-mode guards:

1. `20261107090000_assessments`
2. `20261107100000_review_requests`
3. `20261107110000_patient_imports`
4. `20261107120000_online_visits`
5. `20261107121000_online_mode_guard`

All 57 migrations have applied to disposable PostgreSQL in local verification. The
Coolify migration service must exit successfully before API/workers/web become ready.
Capture a current paired database/private-file backup before deployment. Preserve current
runtime secrets and volumes; do not run bootstrap/reset scripts or change existing MFA.

Reviews default off through `WHATSAPP_REVIEWS_ENABLED=false`; keep this off until approved
Meta templates, token scope, callback/STOP handling and expressly consented recipient
acceptance are complete. New optional Compose fields accept blank default-off values.
Online consultations default off per clinic; leave disabled until verified doctor details
and real provider/clinical acceptance are ready. No video-provider API secret is required
for the external-call workflow. Existing WhatsApp OTP configuration must remain unchanged.

## Verification and release gates

Local feature suites and API/web/worker builds passed as recorded in ADRs 0033–0036.
The latest online increment passed 117 targeted integrations, eight browser checks and
26 scoped lint/type/unit-check tasks. Full GitHub CI remains the release gate, including
all four integration shards, the complete browser suite and container verification.

Before deployment, verify GitHub main/release refs, green CI, current host health, backup
success, public routing and expected feature switches. After deployment, verify migration
completion, service health, public/login routes and authenticated synthetic workflows.
Do not send real provider messages, make payments or place real calls as a smoke test.

## Recovery

Stop rollout if migrations fail, a service stays unhealthy, or the protected login/portal
or existing booking flows regress. Record the exact deployed revision and logs. Preserve
the existing database and files. Do not attempt destructive down migrations or restore
over newly written care records as a routine image rollback.

Before activation, the prior main image can be considered for application rollback while
retaining additive schema, with used-mode restrictions still enforced. Once new workflow
rows or queued review jobs exist, prefer a reviewed forward fix: old contracts/workers may
not understand the new delivery kinds or clinical evidence. Coordinate feature shutdown
and queue recovery before an older image is used. Backup restoration requires a separately
reviewed data-loss window; a backup existing is not proof that restoration was tested.

## Current evidence

- PR [55](https://github.com/heyyrintu/digital-health-care/pull/55) contains this release.
- Review fixes passed 45 focused API integrations (including the corrected 18-test signing
  suite), four mobile/desktop browser scenarios, type checks, lint and formatting. The
  local web build passed with webpack after the local Turbopack worker-port failure.
- At revision `070f066`, GitHub build/unit/browser/container checks and three integration
  groups passed. The fourth exposed an outdated onboarding concurrency assertion: the
  existing nonblocking staff-identity lock intentionally returns a retryable conflict.
  The revised test checks exact refusal, full rollback, safe retry and shared-account
  uniqueness without weakening the lock. Updated-head CI remains required before merge.
- A paired database/private-file backup was created on the application host at
  `/var/backups/dhc/pre-pr55-20261107T133000Z`, with writes paused. `pg_restore -l`, tar
  listing and both SHA-256 checks passed; `COMPLETE` is present. All six long-running
  application services were healthy after restart. This is a same-host recovery copy;
  no restore drill or off-host disaster recovery is claimed.
- Coolify source is `heyyrintu/digital-health-care`, branch `main`, revision `HEAD`.
  Deployment and authenticated hosted workflow verification remain pending.
