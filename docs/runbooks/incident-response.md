# Runbook: Incident Response

**Owner:** Tech lead (incident commander by default)

## Severity
| Level | Examples | Response |
|---|---|---|
| SEV1 | Clinic cannot see queue or sign; data leak suspected; payments marked wrongly | Immediate; all hands; inform clinic within 30 minutes |
| SEV2 | One feature down (WhatsApp, ABDM, scribe) with workaround | Within 1 hour |
| SEV3 | Minor degradation | Next business day |

## Steps
1. **Declare:** open an incident channel; assign commander, communicator, investigator.
2. **Contain:** stop the damage (feature flag off, rollback, revoke keys/devices, block IPs).
3. **Communicate:** clinic contact informed with plain-language status and workaround (e.g. counter payments, paper fallback for signing).
4. **Fix and verify.**
5. **Personal data breach suspected:** engage the lawyer immediately; preserve logs; assess affected data principals; notify as required by the DPDP Rules; notify affected vendors.
6. **Close:** blameless post-incident review within 5 working days; actions tracked; runbooks updated.

## Clinic fallbacks
- Queue down → printed day sheet from last sync / paper tokens.
- Signing down → doctor issues a handwritten prescription; digital copy created and signed when restored.
- Payments down → counter payments only.
- WhatsApp down → SMS automatically.
