# Clinic Admin Guide

## Setup checklist
- [ ] Clinic details, timings, branding and sender settings (WhatsApp number, SMS sender ID, email).
- [ ] **Clinics and consultation types:** on the dashboard, under **Clinics and consultations**, add each place the doctor consults (name and address), then each consultation type with its mode (in person, video or audio call), minutes per slot, fee and optional follow-up fee. Tick *Patients pay when booking* for online consults. Deactivate a clinic or type you stop using; past bookings keep it.
- [ ] **Doctor schedules:** open **Availability**, choose the doctor, clinic and consultation type, and set the weekly sessions (see the Doctor Guide). Add clinic holidays there too (type *Clinic holiday*); a holiday closes the clinic for every doctor. Use **Slots on a day** to check what patients will see.
- [ ] Booking rules: horizon and same-day cutoff and how many extra patients staff may overbook per doctor per day (under **Clinics and consultations → Booking rules**; defaults 30 days, 60 minutes and 2), auto/manual confirm, cancel window, max bookings, no-show limit, follow-up window and fee.
- [ ] Price list and consultation fees; pay-at-booking for online consults (required) and in-person (optional).
- [ ] **Cashfree:** connect the clinic's Cashfree merchant account, choose payment methods, link expiry, test a payment.
- [ ] **UHID numbering:** under **Clinic settings**, set the prefix (for example `EK`) and the next number (for example 10001); the next patient registered gets EK10001. If you import patients, they keep their existing UHIDs and new numbers skip any already in use.
- [ ] **Tags:** choose **Add the default tags** (Emergency, Priority, 2nd opinion, VIP, Insurance, Complaint), then add your own with a colour. Tick *Show these patients first in the queue* for urgent tags. Archive a tag you no longer use; it stays on the patients who have it.
- [ ] **Waiting-room screens:** under **Waiting-room screens**, enter a name (for example *Reception TV*), choose the clinic and **Create screen link**. Open the link on the TV's browser; it is shown only once, so copy it straight away. The screen shows token numbers only. **Revoke** stops a link working (for example if it was shared by mistake), then create a new one.
- [ ] Chart model (shared chart or own patients only).
- [ ] Staff accounts: on the dashboard, under **Staff → Invite staff**, enter their email or mobile number, name and role, then **Create invite link**. Share the link with them directly (it works once and expires in 72 hours). They open it, choose a password and add an authenticator app, and then appear in your staff list. Someone who already has a staff account at another clinic confirms with their current password and authenticator code instead of creating new ones. **Pending invites** shows links not yet used; **Revoke** cancels one. Creating a new invite for the same person and role replaces the old link.
- [ ] Message templates (English and Hindi) and approval status.
- [ ] Import from the previous system (dry run first).

## Daily and weekly
- Collections and outstanding dues; reconciliation mismatches from Cashfree.
- Delivery log for failed messages.
- Data-rights requests and merge requests.
- Free-text medicines waiting to be added to the master.

## Lost phone or authenticator
If a staff member loses their phone or authenticator app, open **Staff** on the dashboard and choose **Reset sign-in** next to their name. This signs them out everywhere and clears their password and authenticator; you get a new link (valid 72 hours) to give them directly. They open it, choose a new password and set up the authenticator again — their role stays the same. You cannot reset your own sign-in (ask another clinic admin), and someone who also works at another clinic needs platform support: ask them to contact support, who will call them back on their registered number and ask you (or the other clinic's admin) to confirm before sending a new link. Their reset shows in your audit log as `support.authenticator.reset`.

## Security
Remove staff accounts the same day someone leaves. For a lost staff phone, use **Staff → Reset sign-in**, which ends all their staff sessions (signing out a single device is not available yet). Review the audit log monthly.
