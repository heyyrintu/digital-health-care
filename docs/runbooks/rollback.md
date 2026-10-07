# Runbook: Rollback

**Owner:** DevOps · **Decision:** tech lead (or on-call engineer if unreachable for 15 minutes during an incident)

## Web and API
1. Switch ECS traffic back to the previous (blue) task set — previous image tag is in the release record.
2. Migrations are backward compatible (expand/contract), so the database is not rolled back. If a migration itself is faulty, stop and escalate; do not hand-edit production data.
3. Confirm health checks and error rates return to normal.
4. Open an incident note and a fix PR.

## Mobile
1. Pause the staged rollout (Play Console / App Store phased release).
2. If the issue is JavaScript-only, publish an EAS Update reverting to the previous bundle for affected channels.
3. If native, submit a fixed build; meanwhile disable the affected feature with a server-side flag if possible.
4. If the API must stay compatible with the bad version, keep compatibility until the fix reaches users.
