# ADR 0005: Tablet and iPad support in the Clinic app

- **Status:** Accepted
- **Date:** 2026-10-06
- **Deciders:** Tech lead, platform owner
- **Related:** Build Plan decision D5

## Context
The doctor uses his phone today; an iPad two-pane layout makes consultations faster and front desk can use tablets.

## Options considered
| Option | For | Against |
|---|---|---|
| Phone layout scaled up | Less work | Wastes space; slow consultations |
| Adaptive two-pane layout | Queue + consultation side by side; keyboard shortcuts | More layouts to design and test |

## Decision
The Clinic app adapts by width: single column on phones, two panes on iPad and Android tablets, with landscape, Split View and keyboard shortcuts. The Patient app is phone-first and adapts on tablets.

## Consequences
- Tablet layouts designed up front, tested nightly with Maestro.

## Review trigger
Usage data shows tablets unused after 3 months.
