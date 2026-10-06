# Clinic Admin Guide

## Setup checklist
- [ ] Clinic details, timings, branding and sender settings (WhatsApp number, SMS sender ID, email).
- [ ] Booking rules: horizon, same-day cutoff, auto/manual confirm, cancel window, max bookings, no-show limit, follow-up window and fee.
- [ ] Price list and consultation fees; pay-at-booking for online consults (required) and in-person (optional).
- [ ] **Cashfree:** connect the clinic's Cashfree merchant account, choose payment methods, link expiry, test a payment.
- [ ] Tags and UHID prefix/start number.
- [ ] Chart model (shared chart or own patients only).
- [ ] Staff accounts: **Invite staff** with their email or mobile number and role. Share the link with them directly (it works once and expires in 72 hours). They open it, choose a password and add an authenticator app. You can see each invite's status and revoke one that hasn't been used.
- [ ] Message templates (English and Hindi) and approval status.
- [ ] Import from the previous system (dry run first).

## Daily and weekly
- Collections and outstanding dues; reconciliation mismatches from Cashfree.
- Delivery log for failed messages.
- Data-rights requests and merge requests.
- Free-text medicines waiting to be added to the master.

## Lost phone or authenticator
If a staff member loses their phone or authenticator app, open **Staff** on the dashboard and choose **Reset sign-in** next to their name. This signs them out everywhere and clears their password and authenticator; you get a new link (valid 72 hours) to give them directly. They open it, choose a new password and set up the authenticator again — their role stays the same. You cannot reset your own sign-in (ask another clinic admin), and someone who also works at another clinic needs platform support.

## Security
Remove staff accounts the same day someone leaves; revoke lost devices; review the audit log monthly.
