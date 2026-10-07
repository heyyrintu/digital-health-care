# ADR 0010: Releases with EAS and CI

- **Status:** Accepted
- **Date:** 2026-10-06
- **Deciders:** Tech lead, platform owner
- **Related:** Build Plan decision D10

## Context
We need frequent, safe releases to two stores and the web.

## Options considered
| Option | For | Against |
|---|---|---|
| Manual builds on a Mac | No subscription | Slow, error-prone, single point of failure |
| EAS Build/Submit/Update + CI for web/API | Repeatable, automated, OTA fixes for JS | Subscription cost; OTA policy discipline |

## Decision
EAS builds and submits both apps; TestFlight and Play testing tracks; staged rollouts; EAS Update only for JS/asset fixes. Web and API: images promoted dev to staging to production with blue-green deploys.

## Consequences
- OTA never changes reviewed behaviour, permissions or native code.
- Forced-update screen for unsupported app versions.

## Review trigger
Build volume makes self-hosted runners cheaper.
