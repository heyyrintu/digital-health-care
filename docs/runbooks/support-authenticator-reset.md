# Runbook: Platform-Support Authenticator Reset

**Owner:** Tech lead · **When:** a staff member who works at more than one clinic has lost their phone or authenticator (or forgotten their password), so no clinic admin may reset them (threat model T22).

Staff at a single clinic are reset by their own clinic admin from the dashboard (**Staff → Reset sign-in**). Send those requests back to the clinic admin; don't use this runbook.

## Why support does this
The password and authenticator belong to the person, not to a clinic. If clinic A's admin could reset someone who also works at clinic B, clinic A could take over their access to clinic B's patients. So the API refuses, and the reset comes here, where the identity check and approval are recorded and every clinic involved sees it in its audit log.

## 1. Open a ticket
Record in the support ticket: who asked, when, through which channel, which clinic the person wants the link for, and why (lost phone, new phone, locked out). Never put a reset link, a password or an authenticator code in the ticket.

## 2. Verify identity (two checks, both recorded)
1. **Callback.** Call the person back on the mobile number recorded for them (from a clinic admin or the staff record, not a number given in the request) and confirm they asked.
2. **A clinic admin vouches.** A clinic admin at one of the person's clinics confirms in writing (email from their registered address, or a ticket comment) that this is their staff member and that the request is expected.

If either check fails or looks off (urgency, new number, a request to send the link somewhere else), stop and treat it as a possible takeover attempt: see [incident response](incident-response.md).

## 3. Get approval
A second person (tech lead or delegate, not the operator) approves on the ticket. Production database access for the command follows the break-glass rule in the [access control policy](../security/access-control.md): approved, time-limited, recorded.

## 4. Run the command
From a production API task (the command ships in the API build) with `DATABASE_URL` and `WEB_BASE_URL` set as for the API, in a recorded session:

```sh
node dist/support-reset-authenticator.js \
  --identifier doctor@example.test \
  --clinic clinic-a \
  --ticket SUP-1234 \
  --operator your.name@platform.example \
  --reason "Lost phone; callback and clinic-a admin confirmation on ticket" \
  --dry-run
```

`--identifier` is the person's email or mobile number; `--clinic` is the clinic ID (slug) the link should open into, which must be one of their clinics. Locally, `pnpm --filter @dhc/api support:reset-authenticator --identifier … --clinic …` runs the same command from source.

The dry run prints who the person is (masked), every clinic and role they hold, how many staff sessions will end and how many open links will be revoked. Check that it matches the ticket. Then run it again without `--dry-run`: it shows the same plan and asks you to type `RESET`. In a recorded non-interactive session, pass `--yes` instead.

What it does:
- clears the person's password and authenticator, and their lockout;
- signs them out of every staff session at every clinic;
- revokes every open invite or reset link they have, at any clinic;
- issues one reset link (single use, 72 hours) for the chosen clinic;
- writes `support.authenticator.reset` into the audit log of **each** of their clinics, and `support.reset.link_created` into the chosen clinic's, with the ticket, operator and reason. The audit request ID is the run ID the command prints.

The link is printed on its own line on standard output; everything else goes to standard error.

## 5. Deliver the link
Send the link only to the person, through a different channel from the request where possible: for example, read it out on the callback, or send it to their verified email. Don't send it to whoever asked on their behalf, and don't paste it into the ticket or chat.

The person opens it, chooses a new password and sets up their authenticator again. That restores sign-in at all their clinics, with their roles unchanged.

## 6. Close out
On the ticket, record the run ID, the time, and that the link was delivered (not the link itself). Tell the clinic admins who vouched that the reset is done. If the link expires unused, run the command again: the old link stops working when a new one is issued.

## If something goes wrong
- **"No active staff member with that email or mobile."** Check the spelling; a removed staff member can't be reset (their clinic admin invites them again instead).
- **"The link must open into one of this person's clinics: …"** Use one of the clinic IDs listed.
- **It turns out the person never asked.** Don't deliver the link; nobody else has it, and it expires in 72 hours. Open an incident, and contact the person through their clinic admin so they know their sign-in was reset and can get a fresh link.
