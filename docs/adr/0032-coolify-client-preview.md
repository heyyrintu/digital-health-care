# ADR 0032: Coolify client-preview hosting

- Status: accepted for the client-preview deployment
- Date: 2026-11-05

## Context

The owner wants to demonstrate the existing web progress on Coolify before completing the remaining features and provider configuration. Native development remains paused; cloud DSC and AI providers remain deferred. The old ECS promotion runbook describes a future architecture, not a working deployment pipeline.

## Decision

Ship a Git-based Compose application (`docker-compose.coolify.yml`) using Linux production builds of Next standalone, the API and workers. One nginx gateway exposes the web and `/v1` through the same HTTPS origin; Coolify terminates TLS. Database, queue and application ports are not published on the host. nginx resolves Docker service names dynamically so a recreated backend does not leave stale proxy addresses.

Run PostgreSQL 16 and Redis 7 with named volumes, and retain the current private FileStore on a named API volume for this single-server preview. A one-shot migration service must finish successfully before application services start. Use dependency probes, startup PDF validation, bounded logs and explicit memory budgets. The preview is not a multi-server object-storage architecture.

Keep `NODE_ENV=production`, OTP and legal signing disabled, and all external provider features off. Bootstrap only an empty synthetic database through an explicit operator command; retain password/MFA onboarding and all role controls. Show a preview notice and exclude the gateway from indexing. No default passwords or production auth bypasses are introduced.

Server-side web requests use the private API URL; browser requests use the configured public origin. Session origin checks use the configured public web origin, including protocol and port, rather than Next's internal container URL or an untrusted forwarded host.

Back up database and private files at the same stopped-writer maintenance point. Keep original encryption keys separately. Require an isolated restore drill before relying on backups. Application rollback must account for already-applied migrations; do not automatically reverse database migrations.

## Consequences

This provides a concrete hosting path for the client demonstration without requiring deferred providers or native builds. The release checkout, volumes and keys must be kept together operationally. The initial backend image retains workspace dependencies and operational tools to keep Prisma, generated assets and PDF/font resolution reliable; it is larger than a separately pruned runtime image.

Client-preview acceptance is distinct from real-patient launch acceptance. Actual DNS/TLS/proxy settings and the final presentation must be rehearsed on the owner's Coolify hostname. The remaining feature, provider, security and clinical launch gates remain in the build plan.

See [Coolify runbook](../runbooks/coolify.md) and [client-preview walkthrough](../product/client-preview-guide.md).
