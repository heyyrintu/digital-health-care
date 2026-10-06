# ADR 0004: Two store apps from one codebase

- **Status:** Accepted
- **Date:** 2026-10-06
- **Deciders:** Tech lead, platform owner
- **Related:** Build Plan decision D4

## Context
Patients and clinic staff have different sign-in methods, permissions and store listings, and the patient app may be white-labelled per organisation later.

## Options considered
| Option | For | Against |
|---|---|---|
| One app with modes | One listing | Mixed auth, larger patient download, confusing privacy labels |
| Two apps from one codebase | Clear listings, least-privilege permissions, white-label ready | Two submissions per release (automated) |

## Decision
Ship a Patient app and a Clinic app, selected by EAS build profile from the same Expo project.

## Consequences
- Two bundle IDs / application IDs, icons, listings and privacy declarations.
- Shared screens live in packages; app-specific navigation per profile.

## Review trigger
Store review or user research shows staff want a single combined app.
