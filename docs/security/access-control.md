# Access Control Policy

**Status:** Draft · **Owner:** Tech lead

## Principles
Least privilege; access by role and organisation; clinical data only for treating doctors and the patient; every record view of clinical data is logged.

## Roles
Patient, Doctor, Front desk, Clinic Admin, Platform Admin (no clinical access), Verifier (public QR page). Permission matrix: PRD v3.0 §3.2.

## Production access (engineering)
| Access | Who | How | Review |
|---|---|---|---|
| Cloud console | DevOps + tech lead | SSO with MFA, named accounts | Quarterly |
| Production database | No standing human access | Break-glass role with approval, time-limited, recorded | Every use |
| Platform console (organisations, doctor verification, usage, system health; no clinical data) | Platform Admin: named platform operator accounts, separate from clinic users | Created, disabled, enabled, re-enrolled and given a new password only with the `support-platform-operator` command under break-glass, on a ticket approved by the tech lead or delegate (not the person); password resets require the operator to be disabled first; password and authenticator; reachable only from `PLATFORM_ALLOWED_CIDRS` (office or VPN), which is reliable only when the API can be reached through the load balancer alone or `TRUSTED_PROXY_CIDRS` is set; every sign-in, view and change audited, except that a system health view while the database is unavailable may have no audit entry (logged instead; threat model T17) ([runbook](../runbooks/platform-operators.md), ADR 0016) | Quarterly, and disabled the same day on leaving |
| Staff authenticator reset (multi-clinic staff) | Platform support operator | Support command under break-glass, after identity checks and second-person approval ([runbook](../runbooks/support-authenticator-reset.md)); audited into each affected clinic | Every use |
| Logs and metrics | Engineers | Read-only, no PHI in logs | Quarterly |
| Secrets (Cashfree keys, DSC, AI keys) | Services only | Secret store; humans rotate via runbook | On rotation |
| App store and Play consoles | Product owner, tech lead, mobile lead | Organisation accounts with 2FA | Quarterly |

## Joiners and leavers
Accounts created by role on joining; removed the same day on leaving (staff devices revoked, cloud and store access removed, platform console operator disabled, keys rotated if they had access).

## Clinic staff
Clinic Admin manages staff accounts and devices; front desk sees no clinical content; chart model (shared vs own patients) set per organisation. The clinic admin's medicine list and approval queue show medicine names typed by doctors with usage counts only, never patients or prescriptions. Patient merges are asked for by front desk, doctors and clinic admins and decided only by a clinic admin; the comparison shows demographics and visit counts, never clinical content.

Test orders (PRD §7.1): only the visit's doctor writes them, with the prescription draft, and they lock when it is signed. Doctors read a patient's orders and open result files under the chart model (a doctor's own orders are always open to them); only doctors mark results reviewed. The front desk lists a patient's ordered tests without the doctor's notes and uploads results that come to the counter, but cannot open result files. Clinic admins have no access. Patients see and upload against the ordered tests of their own account's patients and dependants, and open those results. Listing (by staff and in the Patient app), uploading, opening and reviewing are audited; the doctor's results-to-review worklist is not, like the queue. The public QR check shows the test names a prescription printed, never notes or results.
