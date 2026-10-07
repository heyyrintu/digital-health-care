# ADR 0009: Limited offline mode

- **Status:** Accepted
- **Date:** 2026-10-06
- **Deciders:** Tech lead, platform owner
- **Related:** Build Plan decision D9

## Context
Clinic networks drop; full offline sync of clinical records adds conflict risk.

## Options considered
| Option | For | Against |
|---|---|---|
| Online only | Simple | Clinic stalls on network drops |
| Full offline replication | Works anywhere | Complex conflicts on clinical data |
| Read-mostly cache + queued writes | Covers real clinic needs with low risk | Some actions unavailable offline |

## Decision
Cache today's queue, opened summaries, drafts, templates and medicine master; queue check-in, vitals, notes, tags, counter payments (cash, or UPI or card taken at the desk, recorded for sync) and scribe uploads with idempotency keys. Signing, booking, online payments (payment links and checkout), ABDM and Ask AI require a connection.

## Consequences
- Clear 'waiting to sync' states; server rejections explained with a fix.

## Review trigger
Pilot shows frequent long outages at the clinic.
