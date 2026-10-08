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
| Staff authenticator reset (multi-clinic staff) | Platform support operator | Support command under break-glass, after identity checks and second-person approval ([runbook](../runbooks/support-authenticator-reset.md)); audited into each affected clinic | Every use |
| Logs and metrics | Engineers | Read-only, no PHI in logs | Quarterly |
| Secrets (Cashfree keys, DSC, AI keys) | Services only | Secret store; humans rotate via runbook | On rotation |
| App store and Play consoles | Product owner, tech lead, mobile lead | Organisation accounts with 2FA | Quarterly |

## Joiners and leavers
Accounts created by role on joining; removed the same day on leaving (staff devices revoked, cloud and store access removed, keys rotated if they had access).

## Clinic staff
Clinic Admin manages staff accounts and devices; front desk sees no clinical content; chart model (shared vs own patients) set per organisation. The clinic admin's medicine list and approval queue show medicine names typed by doctors with usage counts only, never patients or prescriptions.
