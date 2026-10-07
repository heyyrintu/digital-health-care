# Runbook: Key and Secret Rotation

**Owner:** DevOps · **Schedule:** every 90 days, and immediately on suspected exposure or staff departure.

| Secret | Where | Rotation steps |
|---|---|---|
| Cashfree API keys (per organisation) | Secret store | Generate new keys in the organisation's Cashfree dashboard → update secret → verify a sandbox/prod order → revoke old keys |
| Cashfree webhook secret | Secret store | Update in Cashfree and secret store together; verify with a test event |
| WhatsApp / SMS / email provider keys | Secret store | Create new key → update → send test → revoke old |
| DSC provider credentials | Secret store | Per provider procedure; test signature in staging first |
| AI vendor keys | Secret store | Create new → update → test scribe in staging → revoke old |
| JWT signing keys | Secret store (key set) | Add new key, sign with new, keep old for verification until tokens expire, then remove |
| Database credentials | Secret store + RDS | Rotate via managed rotation; restart services gracefully |
| Field-encryption keys | KMS | Rotate KMS key (envelope encryption); re-encrypt data keys in background |

Log every rotation in the security log with date and person.
