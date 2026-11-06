# Clinic Admin Guide

## Setup checklist
- [ ] Clinic details, timings and sender settings (WhatsApp number, SMS sender ID, email).
- [ ] **Branding:** on the dashboard, under **Branding**, choose how your clinic looks on your doctors' public pages and on the patient portal's sign-in (the link your doctors' pages and clinic links open, `/app/login?clinic=<your clinic ID>`), and in the portal's header once patients sign in. The platform's home page stays the same for every clinic; your cards there show your display name.
  - *Display name*: the name patients see on those pages (up to 80 characters, one line, without hidden or direction-changing characters), for example *Sharma Family Clinic*. Leave it empty to use your organisation's registered name, which prescriptions, receipts and staff screens always keep.
  - *Tagline*: one short line under the name on the portal sign-in (up to 120 characters).
  - *Accent colour*: the colour of buttons such as **Book an appointment** and **Send code**, as `#rrggbb` or from the colour picker. The buttons have white text, so a colour too light to read it on is refused: the card shows the contrast as you type and needs at least 4.5:1 (darker colours pass). Leave it empty for the platform's colour.
  - **Save branding** saves the three; the **Preview** shows a doctor page header and its Book button as you type.
  - *Logo*: **Upload logo** takes a still PNG, JPEG or WebP image up to 512 KB, 4096 pixels on a side and 4 million pixels in all (about 2000 × 2000), shown small (about 40 pixels high), so a wide logo on a plain or transparent background works best. SVG files (they can carry code) and animated images are not accepted. A file that is damaged, or carries anything besides the picture, is refused: export it again from your design tool as PNG. **Remove logo** takes it off. A new logo replaces the old one.
  Changes show on the portal sign-in, the logo and doctors' pages within five minutes. A patient who changes the clinic ID on the sign-in page sees the platform's look instead of yours. Each change shows in the audit log under *Branding* with what changed, not the old or new text.
- [ ] **Clinics and consultation types:** on the dashboard, under **Clinics and consultations**, add each place the doctor consults (name and address), then each consultation type with its mode (in person, video or audio call), minutes per slot, fee and optional follow-up fee. Tick *Patients pay when booking* for online consults. Deactivate a clinic or type you stop using; past bookings keep it.
- [ ] **Doctor schedules:** open **Availability**, choose the doctor, clinic and consultation type, and set the weekly sessions (see the Doctor Guide). Add clinic holidays there too (type *Clinic holiday*); a holiday closes the clinic for every doctor. Use **Slots on a day** to check what patients will see. A doctor's public page (if they publish one) lists the clinics and consultation types they have a schedule for, with fees, so keep names and addresses as patients should read them.
- [ ] Booking rules (under **Clinics and consultations → Booking rules**): how far ahead patients may book and when same-day booking closes (defaults 30 days, 60 minutes), how many extra patients staff may overbook per doctor per day (2), when an unattended booking becomes a no-show (minutes after its slot ends, default 30; leave it empty to have staff mark no-shows by hand only), and for the Patient app: upcoming bookings per patient (2), the no-show pause (3 in 90 days; 0 turns it off), how late patients may cancel (120 minutes) and whether their bookings are confirmed at once or wait for the front desk. Follow-up window and fee come later.
- [ ] **Price list:** on the dashboard, under **Price list**, add each item billed besides the consultation (for example *Dressing*, ₹150). **Change price** affects new bills only; bills already made keep their price. Deactivate an item you stop charging for. Pay-at-booking for online consults (required) and in-person (optional) is planned with Cashfree in phase 3.
- [ ] **Cashfree:** connect the clinic's Cashfree merchant account, choose payment methods, link expiry, test a payment.
- [ ] **UHID numbering:** under **Clinic settings**, set the prefix (for example `EK`) and the next number (for example 10001); the next patient registered gets EK10001. If you import patients, they keep their existing UHIDs and new numbers skip any already in use.
- [ ] **Tags:** choose **Add the default tags** (Emergency, Priority, 2nd opinion, VIP, Insurance, Complaint), then add your own with a colour. Tick *Show these patients first in the queue* for urgent tags. Archive a tag you no longer use; it stays on the patients who have it.
- [ ] **Waiting-room screens:** under **Waiting-room screens**, enter a name (for example *Reception TV*), choose the clinic and **Create screen link**. Open the link on the TV's browser; it is shown only once, so copy it straight away. The screen shows token numbers only. **Revoke** stops a link working (for example if it was shared by mistake), then create a new one.
- [ ] **Chart, safety alerts and files:** on the dashboard, under **Chart, safety alerts and files**:
  - *Who sees the chart*: **Shared chart** (the default) lets every doctor see a patient's full history. **Own patients only** opens a patient's chart, notes and prescriptions to a doctor once the patient has been checked in to them; until then the doctor sees a message instead.
  - *Safety alerts doctors see*: untick an alert to hide it from doctors. Only three non-critical alerts can be hidden: moderate and minor drug interactions, two medicines of the same class, and medicines to use with care in adults 65 and over. Blocks, allergies and serious interactions always show.
  - *Uploads*: the largest file (up to 25 MB; 10 MB to start) and the file types accepted (PDF, JPEG and PNG to start; tick iPhone photo (HEIC) for photos straight from an iPhone). These apply when patient and staff uploads arrive.
  Each change shows in the audit log under *Settings*.
- [ ] Staff accounts: on the dashboard, under **Staff → Invite staff**, enter their email or mobile number, name and role, then **Create invite link**. Share the link with them directly (it works once and expires in 72 hours). They open it, choose a password and add an authenticator app, and then appear in your staff list. Someone who already has a staff account at another clinic confirms with their current password and authenticator code instead of creating new ones. **Pending invites** shows links not yet used; **Revoke** cancels one. Creating a new invite for the same person and role replaces the old link.
- [ ] **Medicines:** under **Medicines → Medicine list**, search the reference list (read-only) and add the products your doctors prescribe that are missing, with their molecules and strengths. **Edit** changes the clinic's own medicines; **Deactivate** hides one from doctors' search (prescriptions keep it). *Show inactive* finds them again.
- [ ] **Document library:** under **Library** in the menu, add the sheets your doctors give patients (exercise sheets, diet charts, information leaflets) with **Add sheet**: choose the file (a PDF or an image: JPEG, PNG or WebP, within the clinic's upload limit; SVG and web pages are refused, and so are password-protected PDFs and PDFs over 500 pages: save those as an unprotected, shorter PDF first), a title, a category (optional) and the language. Uploaded PDFs are rebuilt from their pages, so forms and links in uploaded PDFs are removed, as are bookmarks, attachments and comments; the pages themselves look the same. To keep a filled-in form's answers, print it to a new PDF before uploading. Doctors can add sheets too. **Edit** renames a sheet or gives it a new file; patients who already received it keep the version they were sent, and new shares get the new file. **Archive** takes a sheet out of use (doctors can no longer share it; patients keep their copies) and **Restore** brings it back from the **Archived** tab; sheets are never deleted. Each sheet shows how many times it was shared. You do not see what was shared with which patient: that is part of the patient's record, for doctors only.
- [ ] Message templates (English and Hindi) and approval status.
- [ ] Import from the previous system (dry run first).

## Daily and weekly
- **Clinic at a glance** (top of the dashboard): appointments, completed visits, cancellations, no-shows with their rate, new patients, prescriptions signed and money collected for today, the last 7 or the last 30 days, with a row per day.
- **Audit log** (in the menu): who did what and when, newest first. Filter by area (sign-in, staff, patients, appointments, chart views, notes, vitals, prescriptions, bills, payments, receipts, settings, branding, documents), by staff member and by dates, and use **Load more** for older entries. Records are shown by ID; patient names never appear in the log.
- **Collections** (in the menu): a day's payments by mode (cash, UPI, card) and by doctor, each with its receipt, and the visits still due. Reconciliation mismatches from Cashfree come with online payments.
- Delivery log for failed messages.
- **Patient merges** (in the menu): duplicate records staff asked to merge. Compare the two records side by side (UHID, name, mobile, date of birth, gender, registration date and completed visits) and read the reason. **Approve merge** closes the duplicate: its allergies, conditions, medicines, tags, upcoming bookings and family links move to the record that stays, and its past visits and prescriptions show there. A merge cannot be undone, so check it is the same person first. **Reject** keeps both records and needs a reason. If the duplicate is a guardian and the kept record has a guardian of its own, change the family links first.
- Data-rights requests.
- **Medicines → Approval queue** (in the menu): the names doctors typed because they were not in the medicine list, most used first, with how many prescriptions and doctors used each (never patients). For each one choose:
  - **Add as new medicine**: the form opens with the typed name; fill in the generic name, composition, form and usual route, and add each molecule with its strength (mg per tablet, capsule or drop, or per ml; *Not in mg* for creams and IU). Without molecules the safety checks cannot see the medicine and the doctor gets a warning.
  - **Same as a listed medicine**: search the list and choose **Link to …** when the name is a brand or spelling of a medicine already listed (for example *crocin* → Paracetamol 500).
  - **Reject**, with a reason, when it is not a medicine (an appliance or a test). Doctors can still type it.
  After approval, doctors searching the typed name find the medicine. Prescriptions already written are not changed. **Decisions** lists what was decided, by whom and when; **Undo** puts a name back in the queue (a medicine it added stays in the list).

## Signed-in devices
On the dashboard, under **Staff**, choose **Devices** next to someone's name to see where they are signed in at this clinic: the browser or app, when it was last used and from which network address. **Sign out** ends one device (for example a shared front-desk computer someone forgot to sign out of); **Sign out of all devices** ends every one. They can sign in again with their password and authenticator; their access is not removed. Each sign-out shows in the audit log under *Staff and invites*. Your own current device is marked *This device* and can't be signed out from here (use **Sign out** in the menu).

## Lost phone or authenticator
If a staff member loses their phone or authenticator app, open **Staff** on the dashboard and choose **Reset sign-in** next to their name. This signs them out everywhere and clears their password and authenticator; you get a new link (valid 72 hours) to give them directly. They open it, choose a new password and set up the authenticator again — their role stays the same. You cannot reset your own sign-in (ask another clinic admin), and someone who also works at another clinic needs platform support: ask them to contact support, who will call them back on their registered number and ask you (or the other clinic's admin) to confirm before sending a new link. Their reset shows in your audit log as `support.authenticator.reset`.

## Security
Remove staff accounts the same day someone leaves. For a lost staff phone, use **Staff → Reset sign-in**, which ends all their staff sessions; to end just one device, use **Staff → Devices**. Review the audit log (in the menu) monthly.


## WhatsApp delivery

Open **WhatsApp delivery** to see the status of patient sign-in codes. Accepted means Meta has accepted the request; Sent, Delivered and Read come from WhatsApp receipts and may arrive later. Send request failed means the request could not be confirmed; Delivery failed means WhatsApp reported a failure. **Refresh** updates the list and **Load more** shows older entries. Only your organisation's delivery metadata appears; patient names, numbers and codes are not shown. If statuses stay at Accepted, ask the operator to check the callback and background worker setup. This page does not send or resend codes.


## Appointment messages

On a patient's page, **WhatsApp appointment messages** starts off. Confirm the number holder agreed before enabling it. The preference covers that number across the practice, including family records using it. It applies to new confirmed bookings after enabling: one confirmation and, for bookings made far enough ahead, one reminder 24 hours before the visit. Pending bookings and walk-ins do not send messages. Turning it off cancels queued messages; patients can also revoke it in the portal or reply STOP. A record without its own number receives no automatic guardian-number fallback.

The delivery log's Message column distinguishes sign-in codes, confirmations and reminders. Scheduled, Sending, Skipped and Send status unknown explain outbound progress. Unknown sends are not automatically repeated, to avoid duplicates; ask the operator to check Meta before following up. A request already being sent cannot be recalled on a later cancellation. Appointment messages require operator setup before the controls become available.

### Online payment links

When Cashfree is connected for the clinic, front desk and doctors can create a payment link from an existing bill. It collects the remaining balance; share the link manually. Keep the bill unchanged and do not collect at the counter while the online payment is open. **Check payment status** asks Cashfree for confirmation. **Close payment link** requests closure; wait until closure is confirmed before collecting another way. A confirmed payment appears in the usual receipt and collection report as Online (Cashfree). If review is requested, do not ask the patient to pay again; investigate with the payment provider. Closing a link does not refund money.

### Requesting a refund

When enabled, open the paid bill's **Refunds** card. A clinic admin selects the original online receipt, enters the amount and chooses a reason, then confirms the exact amount and receipt. New requests wait while another refund is unresolved. **Check refund status** only checks; **Recover original request** reuses an unknown request safely. Do not create a replacement after a lost response. Confirmed refunds have an RF voucher you can print. The original receipt remains unchanged, and the bill is not reopened for payment. **Check provider refunds** records verified refunds made in the merchant dashboard. Reports show money received, refunds posted and net collection; a refund-only day can be negative. A review warning requires investigation before another request.

### Settlement reconciliation

When enabled, open **Settlement reconciliation**, choose completed dates (at most 31 days), and request a report. Open a saved report to see progress, settlement gross/fees/tax/adjustments/net, UTR and review items. Automatic reports cover the configured recent period each night. Use linked bills to check missing payments/refunds, investigate unknown transactions with Cashfree, then request a fresh report. Acknowledge review with a reason only after investigation: acknowledgement changes no balance and leaves the original discrepancy visible. Match the UTR/net to your bank statement to confirm bank credit. After five unsuccessful processing attempts, request a new report; failed reports never represent a partial match.

### Prepaid in-person bookings

Once enabled after the sandbox pilot, mark an active scheduled in-person consultation type as requiring prepayment. The web portal reserves its standard server-priced fee before checkout. Your automatic-confirmation setting is captured at reservation time: payment either confirms directly or leaves a paid request for clinic approval. Unpaid holds cannot be checked in or manually confirmed, and do not count as no-shows. Close/check their original order rather than creating a replacement collection. Bill screens and the booking audit area show reservation states. Late payments require receipt/refund review and never restore a released appointment. Prepaid bookings cannot be moved in this increment; handle cancellation and any refund explicitly before rebooking.

### Financial availability notices

When the feature is configured and enabled, record the number holder's explicit **WhatsApp payment updates** consent before a new payment link/receipt/refund event. The three events appear in the delivery log. Existing appointment/record grants do not authorize them, and old financial events are not backfilled. Queued messages are skipped after STOP, contact changes or stale payment status. Investigate uncertain sends rather than automatically resending. Patients can read their own dues/receipts and refund updates in the portal; their original receipt amounts stay unchanged.

### Patient profile updates and number changes

Patients can edit their owned demographics/emergency contacts and private photo. Patient-reported medical facts are labelled pending and do not overwrite doctor facts; permitted doctors confirm them in the consultation chart. Doctors confirm a reported blood group from the patient page after checking it; a changed version must be reloaded. For lost-number or existing-number collisions, verify identity in person before using the clinic's existing demographic/merge process. Self-service transfer cannot bypass this check, change other clinics, or merge clinical records. Do not request or store patient OTPs or identity documents in notes.

### Patient-uploaded records

Only the named doctor (or a doctor who already used the file in care) can read a patient's uploaded record. Front desk/admin roles have no file access. A file grant does not open the rest of a restricted chart. Doctors open patient-uploaded records on the patient/consultation page, explicitly **Mark reviewed**, and choose **Use in this visit → Confirm** whenever relying on the document for care. Use requires the same patient's treating visit and freezes/retains the document. Patient hiding or link expiry never erases that care copy. Unused deletion is asynchronous and retryable; production monitoring/backup retention remain part of release acceptance.

## Patient data-rights queue

Open **Your data and account** to review profile/financial requests and assign clinical requests. Clinical text/replies stay hidden from admins; choose an active doctor who can access the chart. Responses are visible to the requester. Use current revisions; terminal decisions cannot be overwritten. Valid profile corrections apply with completion. Clinical corrections must first be recorded in the consultation/amendment/void workflow; financial completion references an actual posted refund. Other adjustments remain clinic-assisted. A retained response requires your clinic's policy reference; review dates do not schedule deletion. Erasure completion requires the referenced unused upload to have been purged. Closing a patient account leaves care, invoices and appointments intact. Identity disputes, reopening and broader manual access requests require clinic handling.

## WhatsApp inbox and templates

Open **WhatsApp inbox** for masked conversation metadata and handoff of an unassigned request to an active doctor. Message content belongs to the front-desk team until assigned, then to that doctor. Admin access does not reveal private conversation text or grant chart access. Only the assigned doctor may return a conversation to front desk or hand it on.

Open **Message templates**, synchronize from Meta, review the body/language/status and enable the approved static utility templates appropriate to clinic service requests. New or changed templates need explicit enablement; only provider-approved entries can be used. Create/edit templates in the linked Meta WhatsApp Manager. Synchronize at least hourly before use. The inbox does not author or approve Meta templates, support marketing/dynamic/media templates, or replace automated notification settings. Credentials and unique clinic number mappings are configured by the operator later.

Service-template agreement is separate from appointment/record/payment notices. STOP and patient account closure stop matching service contact. Unknown delivery requires status review, never an automatic duplicate send. See the inbox runbook for activation, offboarding and recovery boundaries.

## Bulk clinic session changes

Open **Clinic session changes**. Preview a source doctor/clinic/day/time interval, then explicitly confirm its eligible appointments and unchanged exceptions. A move preserves doctor/type and spacing; choose matching free target slots. Billed, prepaid, started and clinical-record visits need individual review. No bills/refunds are moved. Cancellation/move closes the source interval, including to new walk-ins. A failed allocation or stale snapshot changes nothing. Delays annotate today's waiting visits without changing booked times.

Keep the page open after an interrupted apply and recover the same operation. Recent receipts remain available after reload. Additional WhatsApp updates need configured workers/templates and appointment-category consent; queued is not delivered. Contact anyone left unchanged or not reached. Replacement bookings may still queue normal confirmation/reminder notices independently. See the session-operations runbook for limits and configuration.


## Find settings and add doctors

Use **Clinic settings** (`/clinic/settings`) to edit the organisation name, location
names and addresses, branding and clinic policies. Use **Doctors and staff**
(`/clinic/staff`) to add doctors: choose **Invite staff**, select **Doctor**, enter
their name and email or mobile number, and create the private invitation link.
The doctor opens it to set their password and authenticator. Doctors edit their own
name and professional profile at `/clinic/profile`. These pages require the latest
web/API deployment and the practice identity migration.
