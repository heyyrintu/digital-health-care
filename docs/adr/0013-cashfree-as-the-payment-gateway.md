# ADR 0013: Cashfree as the payment gateway

- **Status:** Accepted
- **Date:** 2026-10-06
- **Deciders:** Tech lead, platform owner
- **Related:** Build Plan decision D13

## Context
Clinics need payment links, in-app and web checkout with UPI, refunds and reconciliation; money must settle to each clinic.

## Options considered
| Option | For | Against |
|---|---|---|
| Record counter payments only | No integration | No links, no prepaid online consults |
| Cashfree Payments | Payment links, React Native SDK with UPI Intent, JS checkout, refunds, settlements and webhooks | Integration and KYC lead time |

## Decision
Use Cashfree for all online collection behind a payments adapter. Each organisation connects its own Cashfree merchant account; payments confirmed only by verified webhook or server status check.

## Consequences
- Card/UPI data never touches our servers.
- Duplicate webhooks de-duplicated via the WebhookEvent store.
- Nightly reconciliation against settlements.

## Review trigger
Fees, reliability, or need for platform-fee splitting.
