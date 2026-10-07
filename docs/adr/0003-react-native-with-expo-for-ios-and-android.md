# ADR 0003: React Native with Expo for iOS and Android

- **Status:** Accepted
- **Date:** 2026-10-06
- **Deciders:** Tech lead, platform owner
- **Related:** Build Plan decision D3

## Context
We need iPhone, iPad and Android apps with a small mobile team and maximum code sharing with web and backend.

## Options considered
| Option | For | Against |
|---|---|---|
| Native Swift + Kotlin | Best platform fidelity | Two extra codebases and skill sets |
| Flutter | Strong UI performance | Different language; no sharing with TypeScript backend/web |
| React Native + Expo | One codebase, shared TypeScript packages, EAS build/submit/update | Occasional native modules; must use development builds, not Expo Go |

## Decision
Build both mobile apps with React Native and Expo (development builds, Expo Router, NativeWind), compiled and shipped with EAS.

## Consequences
- Native modules (Cashfree SDK, document scanner, audio) require config plugins and EAS builds.
- Mobile engineers must test on real low-end Android devices from sprint 1.

## Review trigger
A required native capability is unsupported or performance budgets are missed after optimisation.
