# Runbook: Deploy (web and API)

**Owner:** DevOps

1. Confirm release checklist pre-release items are ticked.
2. Merge release PR to `main`; CI builds container images once and tags them with the commit SHA.
3. Images auto-deploy to dev, then promote the same tag to staging.
4. QA signs off staging.
5. Promote the tag to production (manual approval in CI by the tech lead).
6. Migrations run first (expand step only); then blue-green switch on ECS.
7. Watch dashboards for 30 minutes: 5xx rate, p95 latency, queue depth, payment webhook processing, message delivery.
8. If any alarm fires, follow `rollback.md`.
9. Record the release (version, SHA, migrations, approver).
