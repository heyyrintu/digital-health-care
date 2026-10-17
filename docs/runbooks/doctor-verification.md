# Runbook: Doctor Verification

**Owner:** Tech lead · **When:** a doctor has filled in their prescription pad and needs to sign prescriptions (PRD §9.1 step 4). Unverified doctors cannot sign.

Use the platform console (step 3). The support command (step 3b) is the fallback when the console cannot be used, for example from outside the allowed networks during an incident.

## 1. Open a ticket
Record the doctor, the clinic, and who asked (usually the clinic admin, during onboarding).

## 2. Check the registration
1. Ask the doctor to fill in **Prescription pad** on the web: registration number, medical council, qualifications and prefix.
2. Look the registration number up on the council's register (or the NMC Indian Medical Register) and check that the name, council and qualifications match.
3. Check the registration certificate the doctor sent, against the register.
4. Record on the ticket what you checked and where. Don't attach the certificate to the ticket; keep it where onboarding documents are kept.

If anything does not match, stop and ask the clinic admin. Don't verify.

## 3. Verify in the platform console
Sign in to the platform console as yourself at `/platform/login` (password and authenticator; only from the office network or VPN in `PLATFORM_ALLOWED_CIDRS`), then open **Doctor verification** (`/platform/doctors`):

1. The **Pending** tab lists active doctors across organisations, oldest first, with their organisation, name, masked email or mobile, registration number, council, qualifications and when they submitted them. Find the doctor from the ticket and check these are what you checked in step 2.
2. Choose **Verify**, type the ticket ID, tick the box confirming you checked the registration, and choose **Verify doctor**. The console sends the details exactly as it showed them (`POST /v1/platform/doctors/{profileId}/verify` with `{"ticket": "SUP-1234", "expected": {"registrationNumber": "…", "council": "…", "qualifications": "…", "submittedAt": "…"}}`; the API client's `client.platform.verifyDoctor` does the same).

The console then says the doctor is verified, and the **Verified** tab shows them with your email and the ticket (`verifiedBy`). "Already verified" (`alreadyVerified: true`) means someone verified it before you; nothing changed. The queue shows 200 profiles at a time; **Load more** shows the next page (`?cursor=<nextCursor>`). Doctors who have only set a signing PIN are not in the queue until they fill in the prescription pad.

## 3b. Fallback: run the command
From a production API task (the command ships in the API build) with `DATABASE_URL` set as for the API, in a recorded session:

```sh
node dist/support-verify-doctor.js \
  --identifier doctor@example.test \
  --clinic clinic-a \
  --ticket SUP-1234 \
  --operator your.name@platform.example \
  --dry-run
```

`--identifier` is the doctor's email or mobile number; `--clinic` is the clinic ID (slug). Locally, `pnpm --filter @dhc/api support:verify-doctor --identifier … --clinic …` runs the same command from source.

The dry run prints the doctor (masked), the registration number, council and qualifications on their profile. Check they are what you verified in step 2. Then run it again without `--dry-run` and type `VERIFY` when asked (or pass `--yes` in a recorded non-interactive session).

What it does (console and command alike): marks the profile verified with the time and `operator (ticket)`, and writes `support.doctor.verified` into the clinic's audit log with the ticket, operator and registration number (from the console, also your operator ID). The doctor's next signing attempt works; nothing needs restarting.

## 4. Close out
Record on the ticket the time you verified (the console's **Verified** tab shows it with your email and the ticket, and the clinic's audit log has `support.doctor.verified` with the ticket) or the command's run ID, and tell the clinic admin.

## Afterwards
- If the doctor changes their registration number or council, the profile goes back to *pending*, joins the end of the queue, and needs this runbook again. Qualifications, specialty, prefix and paper size can change without it.
- To withdraw verification (for example a suspended registration), there is no command yet: raise an incident and, with break-glass access ([access control](../security/access-control.md)), set the profile back to pending; record it on the ticket.

## If something goes wrong
- **Console: "Another operator verified this doctor just now"** (409 `profile: verified`). Nothing more to do.
- **Console: "The doctor changed their registration after this list was loaded"** (409 `profile: changed`). The doctor changed their registration number, council or qualifications after you loaded the queue, so what you checked is not what is on the profile. Nothing was verified. Choose **Reload queue** and go back to step 2 with the new details. The command refuses the same way if the profile changes between its dry run and the real run.
- **Console: 404 "No active doctor’s profile with that ID."** The doctor was removed from the clinic since the queue was loaded; reload the queue and ask the clinic admin.
- **Console: "The platform console is not available from this network."** (403) You are outside the allowed networks; connect to the VPN, or use the command (3b).
- **"No active doctor with that email or mobile at that clinic."** Check the spelling and the clinic ID; the person must be an active doctor there.
- **"The doctor has not filled in their registration number…"** Ask the doctor to complete the prescription pad first.
