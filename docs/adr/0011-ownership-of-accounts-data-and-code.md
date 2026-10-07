# ADR 0011: Ownership of accounts, data and code

- **Status:** Proposed
- **Date:** 2026-10-06
- **Deciders:** Tech lead, platform owner
- **Related:** Build Plan decision D11

## Context
Health apps should be published by an organisation; white-labelling for other doctors depends on who owns accounts.

## Options considered
| Option | For | Against |
|---|---|---|
| Clinic owns everything | Clinic control | Blocks platform model; one clinic's accounts serve others |
| Platform operator owns, clinic is customer | Enables multi-doctor platform and white-label | Requires clear customer contract and data processing terms |

## Decision
TBD — recommended: the operating legal entity owns Apple/Google organisation accounts, AWS, domain and code; each clinic is a customer and data fiduciary for its patients, with a data processing agreement.

## Consequences
- Needs D-U-N-S number and organisation verification before store submission.

## Review trigger
Decision O1 in Build Plan; revisit if business model changes.
