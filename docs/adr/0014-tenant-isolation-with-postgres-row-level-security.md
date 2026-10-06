# ADR 0014: Tenant isolation with Postgres row-level security

- **Status:** Accepted
- **Date:** 2026-10-06
- **Deciders:** Tech lead, platform owner
- **Related:** Build Plan §4.4 (data and tenancy), Phase 0 exit criterion, ADR 0006, threat model T3/T14

## Context
One database serves every organisation. A missing `WHERE organisation_id = …` in any query would leak one clinic's patients to another. Phase 0 cannot exit until a user in organisation A provably cannot see organisation B.

## Options considered
| Option | For | Against |
|---|---|---|
| Filter in application code only | Simple | One forgotten filter leaks data; nothing enforces it |
| Database per organisation | Strong isolation | Operationally heavy for a small team; cross-org platform features harder |
| Postgres row-level security with a restricted role per request | Enforced by the database for every query; one schema | Every request runs in a transaction; policies must be added for each new table |

## Decision
Every tenant table carries `organisation_id` and has RLS enabled. The API connects as the schema owner but never queries as it in a request: it always opens a transaction and switches role.

- **`withTenant(db, organisationId, fn)`** runs `SET LOCAL ROLE dhc_app` and `set_config('app.organisation_id', …, true)`. Policies on tenant tables match `organisation_id` against that setting, for reads (`USING`) and writes (`WITH CHECK`). With no organisation set, `dhc_app` sees nothing.
- **`withAuth(db, fn)`** runs as `dhc_auth` for sign-in: users, sessions, OTP challenges, organisation lookup, membership checks and audit inserts. It has **no** grant on clinical tables, and may only insert `patient` memberships.
- `audit_logs` is append-only: a trigger rejects `UPDATE` and `DELETE` for every role, including the owner.
- Clinical tables are not deletable by `dhc_app` (no `DELETE` grant), matching the retention rules.

Authentication (patient OTP; staff password + TOTP; 15-minute access JWTs; rotating refresh tokens with reuse detection; per-request session check) is documented in `docs/api/api-guide.md` §3.

## Consequences
- A query that forgets its tenant filter returns only the caller's rows, not everyone's.
- Every new table with `organisation_id` must enable RLS and add a `dhc_app` policy in its migration. The integration suite fails if any such table is unprotected.
- The owner role bypasses RLS (policies are not `FORCE`d), so it is used only for migrations and the development seed. In production the API should log in as a role that is a member of `dhc_app` and `dhc_auth` but does not own the schema.
- CI runs the tenant-isolation suite against a real Postgres on every pull request; it is verified to fail when RLS is disabled on `patients`.

## Review trigger
Moving to read replicas or a connection pooler in transaction mode (check `SET LOCAL` behaviour), or a need for platform-wide reporting across organisations.
