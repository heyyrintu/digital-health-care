# Runbook: Doctor Verification

**Owner:** Tech lead · **When:** a doctor has filled in their prescription pad and needs to sign prescriptions (PRD §9.1 step 4). Unverified doctors cannot sign.

The platform console will do this later. Until then, the platform team uses the support command below.

## 1. Open a ticket
Record the doctor, the clinic, and who asked (usually the clinic admin, during onboarding).

## 2. Check the registration
1. Ask the doctor to fill in **Prescription pad** on the web: registration number, medical council, qualifications and prefix.
2. Look the registration number up on the council's register (or the NMC Indian Medical Register) and check that the name, council and qualifications match.
3. Check the registration certificate the doctor sent, against the register.
4. Record on the ticket what you checked and where. Don't attach the certificate to the ticket; keep it where onboarding documents are kept.

If anything does not match, stop and ask the clinic admin. Don't verify.

## 3. Run the command
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

What it does: marks the profile verified with the time and `operator (ticket)`, and writes `support.doctor.verified` into the clinic's audit log with the ticket, operator and registration number. The doctor's next signing attempt works; nothing needs restarting.

## 4. Close out
Record the run ID on the ticket and tell the clinic admin.

## Afterwards
- If the doctor changes their registration number or council, the profile goes back to *pending* and needs this runbook again. Qualifications, specialty, prefix and paper size can change without it.
- To withdraw verification (for example a suspended registration), there is no command yet: raise an incident and, with break-glass access ([access control](../security/access-control.md)), set the profile back to pending; record it on the ticket.

## If something goes wrong
- **"No active doctor with that email or mobile at that clinic."** Check the spelling and the clinic ID; the person must be an active doctor there.
- **"The doctor has not filled in their registration number…"** Ask the doctor to complete the prescription pad first.
