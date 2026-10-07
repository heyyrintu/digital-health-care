# Doctor Guide

For doctors using the Clinic app (phone, iPad, Android) or the web dashboard.

## Getting started
1. Open the invite link from your clinic admin, set a password and add an authenticator app. You are signed in when you finish. If you already work at another clinic on the platform, confirm with your current password and authenticator code instead.
   Later, sign in on the web at `/clinic/login` with your clinic ID, email or mobile, password and the 6-digit code from the app. The web dashboard signs you out after 15 minutes without activity.
2. Complete onboarding: registration details, HPR ID, DSC setup with a test signature, availability, fees, prescription pad and Google review link.
3. You can write notes immediately; you can sign prescriptions once the platform team has verified your registration.

**Lost your phone?** Ask your clinic admin to reset your sign-in. They will give you a new link to set a new password and authenticator. If you work at more than one clinic, contact platform support instead: a clinic admin cannot reset you, and support will call you back on your registered number before sending a link.

## Your availability
Open **Availability** from the dashboard and pick the clinic and consultation type.
- **Weekly schedule:** add one or more sessions per day (for example 10:00–13:00 and 17:00–20:00; the gap is your break), the minutes per slot and an optional break after each slot, and the date it applies from, then **Save schedule**. A new schedule never changes days before its start date, so existing bookings are safe. An upcoming schedule can be withdrawn until it starts.
- **Leave and extra sessions:** add leave for whole days, or give a start and end time for part of a day; it applies at every clinic. Add an extra session on a specific date at the chosen clinic. Either can be removed until it starts.
- **Slots on a day** shows the resulting slots; tick *Show as patients see it online* to apply the clinic's booking horizon and same-day cutoff.

## Your day
- **Queue:** open **Queue** from the dashboard. It shows your patients by default and refreshes every 15 seconds. **My OPD** lists the patient with you first, then everyone checked in: patients tagged Emergency or Priority come first, then in order of arrival, each with their waiting time. **Booked** is everyone not yet arrived, **Completed** is today's finished visits (with your average consultation time), and **Cancelled and no-shows** is the rest. For a checked-in patient choose **Start consultation**, then **Complete** when you are done; the times are recorded. You can also check patients in, mark no-shows, book, reschedule and cancel. Once a patient has checked in, **Consultation** on their row opens the consultation screen. Follow-ups, prescriptions and **Scribe** arrive in later updates.
- **Patient sheet:** call, ABHA, tags, bill and payment link, vitals, records, assessment, refer, review link, video call.

## Consultation
Available now on the web: open **Consultation** from a checked-in patient's row in the queue.
- **Patient chart (left):** allergies (red), conditions and current medicines, and recent visits with their diagnoses. **Add** records a new entry; tick *Reported by the patient* if you have not confirmed it yet, and it shows as unverified. **Remove** asks for a reason; the entry is kept in the record. The chart is shared by the clinic's doctors.
- **Vitals:** front desk may already have recorded them; correct or complete them and choose **Save vitals**. BMI is worked out for you. Children under 12 need today's weight.
- **Notes:** chief complaint, symptoms with duration, examination, diagnosis, plan, tests advised, advice, private notes (never printed or shared) and a follow-up date with **Book follow-up**. For a diagnosis, type a name or code and pick an ICD-10 match, or press Enter to keep your own wording. Notes save by themselves a moment after you stop typing (the top right shows *Saved*). If you had the visit open in another tab, the older tab tells you to reload instead of overwriting newer notes. Another doctor's visit opens read-only.

When prescriptions, safety checks and signing arrive, the full flow will be:
1. Check allergies (red banner), conditions and recent visits.
2. Optional: **Start scribe**. Ambient mode asks the patient for consent first. On stop, review each Draft section and accept, edit or discard.
3. Add diagnosis, plan, tests (e.g. MRI knee, right), advice and follow-up date (book it in one tap).
4. Build the prescription: search medicines, use templates or **Repeat last**. Dosage remarks are written for you in English or Hindi; edit if needed.
5. Resolve the **Safety** panel: red items block signing (a few can be overridden with a typed reason, where the rule allows it); amber need acknowledgement (some need a reason).
6. **Sign** with Face ID / fingerprint (or PIN on web). The prescription locks and goes to the patient automatically.

## After signing
- Wrong detail? Use **Amend** (creates version 2 with a reason) or **Void**. Never re-issue manually.
- Refer, send attachments (exercise sheets), or send a payment link from the patient sheet.

## Ask AI
Ask questions about this patient's record ("When was the last MRI?"). Answers show their sources; if something is not in the record, it says so. It never changes the chart.

## Tips
- iPad: queue on the left, consultation on the right; keyboard shortcuts for next patient, search and sign.
- No network? Today's queue and your drafts keep working; signing waits for the connection.
