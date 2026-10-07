# ADR 0006: Fastify modular monolith on AWS Mumbai

- **Status:** Accepted
- **Date:** 2026-10-06
- **Deciders:** Tech lead, platform owner
- **Related:** Build Plan decision D6

## Context
We need clinical data hosted in India, strong tenant isolation and a backend a small team can run.

## Options considered
| Option | For | Against |
|---|---|---|
| Microservices | Independent scaling | Operational overhead too high for team size |
| Modular monolith + workers | Simple deploys, strict module boundaries, split later if needed | Discipline needed to keep modules separate |

## Decision
One Fastify service (12 modules) plus BullMQ workers, PostgreSQL 16 on RDS Multi-AZ with row-level security, Redis, S3, all in AWS ap-south-1 (Mumbai).

## Consequences
- Every table carries organisationId; RLS policies and CI isolation tests are mandatory.
- Field-level encryption for notes, diagnoses, transcripts and signing material.

## Review trigger
A module's load or release needs diverge significantly from the rest.
