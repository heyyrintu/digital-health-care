# ADR 0016: Platform console reads through aggregate functions

- **Status:** Accepted
- **Date:** 2026-10-17
- **Deciders:** Tech lead, platform owner
- **Related:** PRD §3.2, §3.3, §9.1, §9.3; ADR 0014 (row-level security); threat model T17; `docs/api/api-guide.md` §3s

## Context
The platform console needs to look across every organisation: the organisation list with clinic and staff counts, the doctor verification queue, and usage (appointments, prescriptions, payments) per organisation. The PRD is explicit that the Platform Admin has "organisations, doctor verification, usage and system health only — no scheduling, billing or clinical rights", and threat model T17 says the console has no clinical endpoints.

ADR 0014 makes every clinic request run as `dhc_app` with one organisation set, so a forgotten filter returns only that organisation's rows. The console cannot work that way: it is, by design, not inside any organisation. ADR 0014 named "platform-wide reporting across organisations" as its review trigger. Whatever lets the console count across organisations must not also let it, or a bug in it, read a patient, a note or a prescription.

Platform staff are also not clinic users. They sign in with a password and authenticator like admins, only on the web and only from allowed networks (PRD §3.3), and nothing they hold should open a clinic endpoint.

## Options considered
| Option | For | Against |
|---|---|---|
| Loop over organisations with `withTenant`, counting in each | No new database objects | The console would run as `dhc_app` with full read on clinical tables of each organisation in turn: one wrong query and it reads patients. N transactions per page |
| A role with `BYPASSRLS` and `SELECT` on the tables it counts | Simple SQL in the API | Table-level `SELECT` on `appointments`, `prescriptions`, `payments` is row-level read of clinical data; column grants are easy to widen by accident |
| Read replica or reporting warehouse | Isolates load | Heavy for current scale; the same question (who may read what) moves elsewhere |
| A `dhc_platform` role with no table grants, reading only through `SECURITY DEFINER` functions that return counts and registration details | The database guarantees what the console can learn; the functions are the whole surface; a test pins it | Every new console figure is a migration; the functions bypass row-level security and so must be reviewed as carefully as policies |

## Decision
A new database role, **`dhc_platform`**, and `withPlatform(db, fn)` in `@dhc/db`, which runs `SET LOCAL ROLE dhc_platform` like `withTenant` and `withAuth` do.

- **No grant on any tenant, clinical or clinic-identity table.** `dhc_platform` cannot `SELECT` from `patients`, `appointments`, `prescriptions`, `payments`, `doctor_profiles`, `memberships`, `organisations`, `users`, `sessions` or `audit_logs`. An integration test checks each.
- **Its own tables:** `platform_operators` and `platform_sessions`, on which it has `SELECT`, `INSERT` and `UPDATE` (row-level security on, policy for `dhc_platform` only; `dhc_app` and `dhc_auth` have no grant). They hold secrets: operators' password hashes and encrypted authenticator secrets, and refresh-token hashes. Code running as `dhc_platform` can read them, so the API never returns them and only the sign-in and operator code touch them. Operators are created and disabled only by the `support-platform-operator` command; no HTTP route writes them.
- **Audit:** it may insert into `audit_logs` only rows with no organisation (`platform_write` policy), for sign-in and for what an operator looked at.
- **Reads go through `SECURITY DEFINER` functions**, owned by the schema owner, with a fixed `search_path`, `EXECUTE` revoked from `PUBLIC` and granted only to `dhc_platform`:
  - `platform_organisation_summaries()`: each organisation's name, slug, status and creation time, clinic counts, staff memberships counted by role and status, and active doctors' verification counts.
  - `platform_doctor_profiles(status, profile_id, limit)`: active doctors' registration number, council, qualifications, specialty, verification state and times, the organisation, and the doctor's name with a **masked** email or mobile (`platform_mask_identifier`, the same rule as the API's `maskIdentifier`).
  - `platform_usage(from, to)`: per organisation, counts of visits and first-signed prescriptions over IST days, and the count and total of payments. Counts only.
  - `platform_organisation_slug_taken(slug)`: whether a slug is in use, so onboarding refuses before creating anything.
  - `platform_create_organisation(slug, name, now)`: inserts the organisation row (onboarding step 1) and returns its ID, or null if the slug is taken.
- **Nothing else it can call.** Functions are executable by `PUBLIC` by default and `dhc_platform` is part of `PUBLIC`, so the migration revokes `PUBLIC` from `queue_notify` (granted back to `dhc_app` and `dhc_auth`, whose triggers call it; otherwise the console could send fake live-queue notifications) and from the `SECURITY DEFINER` trigger function `push_devices_match_session` (triggers fire without `EXECUTE`).
- **Writes into an organisation run inside it, as `dhc_app`**, under that organisation's row-level security, exactly as a clinic request would. Onboarding uses `withNewOrganisation`, which creates the organisation through the function above and then switches to `dhc_app` with the new organisation set, in one transaction, to add the first clinic and the first clinic admin's invite (the same `issueJoinInvite` clinic admins use). Verifying a doctor uses the same `verifyDoctorProfile` as the support command, which updates `doctor_profiles` in that organisation and writes `support.doctor.verified` into its audit log.
- **Separate tokens.** Platform access and MFA tokens carry their own audiences (`dhc-platform`, `dhc-platform-mfa`) and are signed with a key derived from the JWT secret (HKDF, `dhc-platform`), so a clinic token never verifies on `/platform/*` and a platform token never verifies on a clinic endpoint, even if one side forgot its audience check. Sessions are checked on every request, as for staff.
- **Network allowlist.** `/v1/platform/*`, sign-in included, answers only from `PLATFORM_ALLOWED_CIDRS`. An empty list means nobody in production and anybody in development and test.

## Consequences
- What the console can learn about organisations, their staff and their tenant and clinical tables is exactly the columns these functions return (it can also read its own operator and session tables, above). Tests check that `dhc_platform` holds no privilege on any table outside `platform_*` except inserting into `audit_logs`, can execute no `SECURITY DEFINER` function outside `platform_*`, that no `platform_*` function is executable by `dhc_app` or `dhc_auth`, that their output columns match no clinical field name, and that console responses carry no patient names, IDs or UHIDs. The table, function and output-column checks discover what they check from the Postgres catalogue, so a new table or `platform_*` function is covered without editing them; the expected list of `platform_*` functions in the test must be updated on purpose.
- The functions run as the owner and bypass row-level security. Adding or changing one is a security review, like a policy change: return counts or non-clinical fields only, keep `SECURITY DEFINER` with a fixed `search_path`, and revoke from `PUBLIC`.
- New console figures (messages and scribe minutes once those exist, system health) need a migration. Until messaging and the scribe exist, usage reports them as `null`.
- Doctor profiles gain `submitted_at` (when a profile went to the queue: first save, or a change of registration number or council) so the queue can be worked oldest first.
- In production the API's login role must also be a member of `dhc_platform` (as for `dhc_app` and `dhc_auth`), and the owner role must not be the one the API logs in as (ADR 0014).
- Break-glass access to clinical data for platform staff is still not provided; if it is ever added it is a separate, logged and time-limited mechanism (T17), not a new function here.

## Review trigger
A console figure that cannot be expressed as a count or a non-clinical field; read replicas or a reporting store; or a request for any platform access to clinical content.
