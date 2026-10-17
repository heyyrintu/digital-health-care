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

   The new operator types their password (at least 12 characters; not shown, asked twice). The command then asks you to **pause the session recording**: the QR code holds the authenticator secret and must not be in the recording. Press Enter once it is paused; the operator scans the QR code with their authenticator app and types the first code. The screen is cleared, and you resume the recording when the command says so. Nothing is saved until that code matches, and that code cannot then be used to sign in.

   The typed key (the same secret as text) is printed only with `--show-key`, for an app that cannot scan; keep the recording paused while it is on screen. Locally, `pnpm --filter @dhc/api support:platform-operator --email …` runs the same command from source.
4. **Close out.** Record the run ID on the ticket. The new operator signs in to the console to check it works.

Never put a password, the authenticator key or a code in the ticket, chat or email.

## Remove an operator
Do this on the person's last day, or at once if their phone or password may be compromised:

```sh
node dist/support-platform-operator.js --disable \
  --email person@platform.example --ticket SUP-1235 --operator your.name@platform.example
```

Type `DISABLE` when asked (or pass `--yes` in a recorded non-interactive session). It disables the account and ends all their console sessions at once.

## Lost or replaced phone
1. **At once:** disable the operator as above (new ticket), so a found phone and a known password are not enough.
2. **Identity check and approval** on the ticket as when adding an operator; the operator comes to the terminal with their new phone.
3. **New authenticator**, with the recording paused for the QR code exactly as when adding:

   ```sh
   node dist/support-platform-operator.js --reset-authenticator \
     --email person@platform.example --ticket SUP-1236 --operator your.name@platform.example
   ```

   It replaces the authenticator (the old phone's codes stop working), ends any sessions and clears a lockout. The password stays as it was; if it may be known to someone else, also follow [Compromised password](#compromised-password) before step 4.
4. **Enable** them again:

   ```sh
   node dist/support-platform-operator.js --enable \
     --email person@platform.example --ticket SUP-1236 --operator your.name@platform.example
   ```

   Type `ENABLE` when asked. The operator signs in with the new authenticator to check it works.

The same `--enable` brings back someone who left and returned, after a new approval on the ticket.

## Compromised password
If an operator's password may be known to someone else (phished, reused, written down), treat it as an [incident](incident-response.md) and:

1. **At once:** disable the operator (new ticket). The account stays shut until step 4.
2. **Identity check and approval** on the ticket, as when adding an operator; the operator comes to the terminal.
3. **New password**, typed by the operator (not echoed):

   ```sh
   node dist/support-platform-operator.js --reset-password \
     --email person@platform.example --ticket SUP-1237 --operator your.name@platform.example
   ```

   It is refused while the operator is active, replaces the password, ends any sessions and clears a lockout. If the phone may also be compromised, run `--reset-authenticator` too.
4. **Enable** them again with `--enable` (as above) and have them sign in to check.

## What is recorded
Every operator's sign-ins, failures, lockouts and logouts, and every list, onboarding (and refused onboarding), verification (and refused verification) and usage view, are in the audit log with no organisation (`platform.*`), naming the operator, so one operator's activity can be reviewed in one place. Onboarding and verification are also in the organisation's own log (`platform.organisation.created`, `support.doctor.verified`). Creating, disabling, enabling and replacing an operator's authenticator or password write `platform.operator.created`, `platform.operator.disabled`, `platform.operator.enabled`, `platform.operator.authenticator_reset` and `platform.operator.password_reset` with the ticket and who ran the command.

## If something goes wrong
- **"An operator with that email already exists."** If they were disabled and are coming back, use `--enable` (and `--reset-authenticator` if their phone changed).
- **"No matching code: nothing was saved."** Check the phone's clock is set automatically, then run the command again.
- **Locked out (429 at sign-in).** It lifts after 15 minutes, or at once with `--reset-authenticator`. Repeated lockouts may be someone guessing: check the audit log for `platform.auth.login.failed` from unfamiliar addresses and treat it as an [incident](incident-response.md).

## Access review
Quarterly, the tech lead lists the active operators (with the audit log's `platform.auth.login.succeeded` for each) against the platform team, disables anyone who no longer needs access, and records the review on a ticket ([access control policy](../security/access-control.md)).
