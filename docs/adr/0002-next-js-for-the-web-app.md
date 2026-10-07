# ADR 0002: Next.js for the web app

- **Status:** Accepted
- **Date:** 2026-10-06
- **Deciders:** Tech lead, platform owner
- **Related:** Build Plan decision D2

## Context
The web serves a public SEO website, the patient portal, the staff dashboard, the platform console and the waiting-room display.

## Options considered
| Option | For | Against |
|---|---|---|
| Separate single-page apps | Simple hosting | No server rendering for SEO; four deployables |
| Next.js App Router, one app | SEO via server rendering, one deployable, demo components port directly | Framework complexity; must keep clinical pages client-only and cache-safe |

## Decision
One Next.js (App Router) app with route groups: public site, /app (patient), /clinic (staff), /platform (console), /display (kiosk).

## Consequences
- Clinical routes are never statically cached.
- Platform console gets its own auth policy and IP allow-list.
- Print stylesheets for prescriptions and receipts live in the web app.

## Review trigger
If the platform console needs isolation for compliance, split it into its own deployable.
