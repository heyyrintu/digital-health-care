# ADR 0008: Server-side signing with cloud Class 3 DSC

- **Status:** Accepted
- **Date:** 2026-10-06
- **Deciders:** Tech lead, platform owner
- **Related:** Build Plan decision D8

## Context
Prescriptions must carry a legally recognised electronic signature, and doctors sign from phones and iPads where USB tokens cannot be used.

## Options considered
| Option | For | Against |
|---|---|---|
| Aadhaar eSign | Legally recognised | OTP per prescription; per-signature fee; slow at clinic volume |
| USB DSC token | Low cost | Does not work on phones/iPads |
| Cloud (remote) Class 3 DSC | Works on any device, fast, legally recognised | Vendor dependency; integration effort |

## Decision
Sign on the server through a cloud DSC provider after doctor approval with biometrics (mobile) or PIN (web). Provider behind an adapter.

## Consequences
- Certificate never leaves the provider; signing events audited.
- Shortlist two providers in phase 0; staging uses test certificates.

## Review trigger
Provider pricing or reliability changes; regulation changes.
