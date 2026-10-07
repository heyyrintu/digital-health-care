# ADR 0001: One TypeScript monorepo

- **Status:** Accepted
- **Date:** 2026-10-06
- **Deciders:** Tech lead, platform owner
- **Related:** Build Plan decision D1

## Context
We need web, two mobile apps and a backend built by a team of about nine, with shared rules (safety, slots, dosage remarks) that must behave identically everywhere.

## Options considered
| Option | For | Against |
|---|---|---|
| Separate repos per app | Independent release cadence | Duplicated types and rules; drift between platforms |
| Monorepo (pnpm + Turborepo) | Shared packages, one CI, atomic changes across API and clients | Larger CI; needs build caching and clear package boundaries |

## Decision
Use a single pnpm + Turborepo monorepo with apps (web, mobile, api, workers) and shared packages (contracts, api-client, domain, safety, i18n, tokens, ui-web, ui-native, config).

## Consequences
- Contract changes break dependants in the same PR, which is intended.
- CI must use remote caching to stay fast.
- Package boundaries enforced by lint rules (no app imports another app).

## Review trigger
Team grows beyond ~20 engineers or a service needs a separate release lifecycle.
