# ADR 0007: REST and OpenAPI with Zod contracts

- **Status:** Accepted
- **Date:** 2026-10-06
- **Deciders:** Tech lead, platform owner
- **Related:** Build Plan decision D7

## Context
Web, mobile and external parties (webhooks, ABDM) need a stable, typed API.

## Options considered
| Option | For | Against |
|---|---|---|
| GraphQL | Flexible queries | Harder caching, webhooks and third-party integration |
| tRPC | Great TypeScript ergonomics | Not usable by external parties; ties clients to server internals |
| REST + OpenAPI 3.1 from Zod | Typed client generation, external-friendly, documented by default | More endpoints to design |

## Decision
REST under /v1, schemas defined in Zod (packages/contracts), OpenAPI generated, typed client generated for web and mobile.

## Consequences
- Idempotency keys on retryable writes; one error shape; cursor pagination.
- Backward compatibility for the two latest app versions.

## Review trigger
Client data needs become highly graph-shaped.
