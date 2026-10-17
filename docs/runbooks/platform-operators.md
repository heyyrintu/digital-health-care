# Runbook: Platform Console Operators

**Owner:** Tech lead · **When:** someone joins or leaves the platform team, or needs console access (PRD §3.2: organisations, doctor verification, usage and system health only).

Platform operators are not clinic users: they have their own accounts, sign in only to the platform console, and have no access to patient or clinical data (ADR 0016). There is no screen or API for creating them; it is done with the support command below.

## Add an operator
1. **Ticket and approval.** Open a ticket naming the person and why they need access. The tech lead (or delegate, not the person) approves on the ticket. Production database access for the command follows the break-glass rule in the [access control policy](../security/access-control.md).
2. **Network.** Check the person will work from a network in `PLATFORM_ALLOWED_CIDRS` (office or VPN). Changing that list is a deploy-time setting change, with its own ticket.
3. **Run the command with the new operator present.** From a production API task (the command ships in the API build) with `DATABASE_URL` and `FIELD_ENCRYPTION_KEY` set as for the API, in a recorded session:

   ```sh
   node dist/support-platform-operator.js \
     --email new.person@platform.example \
     --name "New Person" \
     --ticket SUP-1234 \
     --operator your.name@platform.example
   ```

   The new operator types their password (at least 12 characters; not shown, asked twice), scans the QR code with their authenticator app, and types the first code. Nothing is saved until that code matches. Locally, `pnpm --filter @dhc/api support:platform-operator --email …` runs the same command from source.
4. **Close out.** Record the run ID on the ticket. The new operator signs in to the console to check it works.

Never put a password, the authenticator key or a code in the ticket, chat or email.

## Remove an operator
Do this on the person's last day, or at once if their phone or password may be compromised:

```sh
node dist/support-platform-operator.js --disable \
  --email person@platform.example --ticket SUP-1235 --operator your.name@platform.example
```

Type `DISABLE` when asked (or pass `--yes` in a recorded non-interactive session). It disables the account and ends all their console sessions at once.

A lost phone is handled the same way: disable the operator, then add them again with a new authenticator (use a new ticket).

## What is recorded
Every operator's sign-ins, failures, lockouts and logouts, and every list, onboarding, verification and usage view, are in the audit log with no organisation (`platform.*`), naming the operator. Creating and disabling an operator writes `platform.operator.created` and `platform.operator.disabled` with the ticket and who ran the command.

## If something goes wrong
- **"An operator with that email already exists."** If they were disabled and are coming back, there is no re-enable yet: raise it with the tech lead.
- **"No matching code: nothing was saved."** Check the phone's clock is set automatically, then run the command again.
- **Locked out (429 at sign-in).** It lifts after 15 minutes. Repeated lockouts may be someone guessing: check the audit log for `platform.auth.login.failed` from unfamiliar addresses and treat it as an [incident](incident-response.md).
