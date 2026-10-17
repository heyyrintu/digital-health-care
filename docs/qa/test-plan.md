# Test Plan

**Status:** Draft · **Owner:** QA engineer · **Scope:** web app, Patient app, Clinic app (iPhone, iPad, Android phone and tablet), API and workers, integrations.

## 1. Approach
Testing effort follows risk. Highest risk: safety engine, signing and immutability, tenant isolation, payments (Cashfree), messaging fallback, ABDM consent, scribe consent.

## 2. Test layers and gates
| Layer | Tool | Gate |
|---|---|---|
| Unit (domain, safety, dosage remarks, slots, UHID, bill totals and receipt numbers; web session routes, including the platform console's own cookie, which never stands in for a clinic session or the reverse, and the console's error wording, verify request, usage range and system health wording; mobile session refresh and sign-out, mobile theme contrast; Clinic app idle lock, offline outbox, saved queue and medicine cache; test order wording such as "MRI knee, right", test order lines, result upload checks: file type read from the first bytes, the clinic's types and size; the "Prescribed tests" PDF section in English and Hindi) | Vitest | Every PR |
| API integration (roles, tenants, errors; platform console: separate audience, IP allowlist, lockout, no clinical fields, `dhc_platform` grants, system health with queues not configured, Redis down and a database that does not answer, and with job counts when `TEST_REDIS_URL` is set: a Redis database of its own such as `redis://localhost:6379/15` (as in CI), never the one development workers use, since the test empties its queue; its keys use a test-only prefix too; test orders, `orders.int.test.ts`: the catalogue seeded per organisation, tests saved with the prescription draft and checked against the catalogue, ordered and locked by signing (the API and the database refuse changes), kept unchanged by an amendment that adds one, a prescription of tests only, front desk uploads without seeing notes or files, the clinic's upload limits and a file that is not what it says, the doctor's review and results waiting, "own patients only", another clinic's orders always 404, signing only the tests the screen declared (409 otherwise, also for older clients), an amendment after a catalogue test was deactivated, the database ordering a test only through the version being signed (an insert already ordered, a draft or older version, a wrong time, a reviewer from another clinic), the migration's backfill seeding older organisations once, uploads refused before the body is read without a token or with the wrong role, 413 above 25 MB, a stored file whose hash no longer matches, the file removed when its record cannot be saved, the QR check listing a version's tests, merged duplicates' orders under the kept record, and the Patient app: consents, the family's orders only, audited list views, file headers, uploads for the account and its dependants, never another family's; `upload-rate-limit.int.test.ts`: staff and Patient app uploads share one limit per address) | Vitest + test DB | Every PR |
| Tenant isolation suite | Dedicated | Every PR, blocks merge |
| Web end-to-end | Playwright (`apps/e2e`) — built today: invite page, staff web sign-in (cookie, reload, sign-out, 15-minute idle), dashboard invites, authenticator reset and staff devices (the admin signs one of a doctor's two browsers out, then the other; both land on sign-in; the admin's own device can't be signed out), patient register (UHID settings, tags, walk-in registration with duplicate warning, guardian, edit), availability (clinics, consultation types and booking rules; weekly schedule with validation, leave and slot preview; front desk read-only), appointments (book from the patient page, reschedule, cancel with reason, walk-in, overbook switch, doctor starts and completes a consultation), queue (My OPD order with priority tags, waiting time, search and tag filter; a new walk-in and a patient going in to the doctor appear within seconds without a reload; Follow-ups with a booked and an unbooked patient and the booking link), waiting-room screen (admin creates and revokes a link; kiosk shows tokens, never names) and consultation (doctor adds a patient-reported allergy and removes it with a reason, records vitals with BMI, writes notes with ICD-10 and free-text diagnoses that autosave and survive a reload, follow-up booking link; front desk records a child's vitals from the queue with the weight reminder and cannot open the notes) and prescription builder (medicine search, free-text line, tapering course, English and Hindi remarks, edited remarks kept, autosave survives a reload, save as template; repeat last and applying and deleting a template), and safety checks (a penicillin allergy blocks amoxicillin with no override and clears when the line is removed; warfarin with ibuprofen warns, is labelled patient-reported, needs a reason to acknowledge and keeps the answer after a reload) and billing (front desk bills a visit with a price-list item and a discount, takes cash then UPI, the bill locks and the receipt opens ready to print; clinic admin adds and reprices an item and reads the day's collections and dues), and signing (the doctor fills the prescription pad and sets a PIN; a wrong PIN is refused; signing locks the lines and opens the PDF; the QR page shows Genuine in English and Hindi with initials only; an amendment signs version 2 and the QR for version 1 shows Superseded; voiding with the PIN shows Void; the front desk prints the signed PDF from the queue card, which then offers the copy stamped VOID) and the clinic admin's dashboard (today's figures with the no-show rate, a row per day for 7 days; the audit log filtered by area and by staff member, with patients shown by ID only), and the medicine list (the clinic admin links a typed brand to a listed medicine, adds a typed name as a new medicine with its molecule, rejects a name and undoes it, then deactivates, reactivates and edits the clinic's medicine; reference medicines have no actions; a doctor cannot open the page), and patient merges (the front desk asks to merge a duplicate into the kept record, the clinic admin compares and approves, the duplicate becomes read-only with a link, its allergy moves, and its old UHID leads to the kept record; the front desk cannot open the requests), and the Phase 1 exit check, a full clinic day with the front desk, the doctor and the clinic admin each in their own browser (a new patient registered and added as a walk-in, a booked patient checked in and another marked no-show, vitals, notes and a prescription signed with the PIN, the visit completed, the prescription printed from the queue card, billed and paid in cash with a receipt, then the admin's figures for the day, collections and the audit log), and the clinic settings (the admin limits the chart to own patients, hides the older-adult alert, sets a 5 MB limit and HEIC photos, which survive a reload and show in the audit log; a doctor with only a booking sees the chart is closed), and the platform console (an operator created with the support command's `createPlatformOperator` signs in with password and authenticator code, wrong ones refused; the session is its own httpOnly cookie, opens no clinic page, survives navigation and ends at sign-out; five wrong passwords lock sign-in; onboarding an organisation shows the first admin's invite link once with copy, never in the address or browser storage and gone after a reload, and the link opens that admin's invite; a taken organisation ID is refused at the field; verifying a doctor from the queue needs a ticket and the confirmation, a registration changed meanwhile is refused until the queue is reloaded, and the doctor then shows as verified by the operator and ticket; usage per organisation with "—" for messages and scribe minutes, a reversed date range refused, and Hindi; system health with the database OK, the queues not configured (the browser suite's API runs without Redis; queue counts are covered by the API integration tests), Refresh checking again, and Hindi; every page `noindex`), and test orders (the doctor orders an MRI knee, right and an X-ray knee with AP and lateral views from the catalogue, with a note, which autosave and survive a reload; signing with tests only locks them; the stored signed PDF, whose hash matches, prints them under "Prescribed tests", and the QR page lists them in English and Hindi without the note; the front desk uploads the MRI report from the patient's profile without seeing the note or opening the file; the doctor's dashboard shows one result waiting, the doctor opens it and marks it reviewed, and the dashboard clears) | Every PR (full suite while it is small); nightly once it grows |
| Mobile end-to-end | Maestro (iOS simulator, Android emulator, phone + tablet) | Nightly, before each store build |
| Provider contract tests | Recorded sandbox payloads (Cashfree, WhatsApp, SMS, ABDM) | Nightly |
| Safety rule pack | `safety/safety-rule-catalogue.md` cases | Any rule change |
| Accessibility | axe, screen readers, dynamic text | Each release |
| Performance | k6, device profiling | Before pilot and launch |
| Security | External pen test | Before pilot, yearly |

## 3. Synthetic personas (never real patients)
| Persona | Use |
|---|---|
| Asha Verma, 34, penicillin allergy, WhatsApp opted in | Allergy rules, WhatsApp flows |
| Ravi Mehra, 58, on warfarin, CKD | Interactions, drug–condition, kidney warnings |
| Neha Kapoor, 29, pregnant | Pregnancy rules |
| Aarav (6) under guardian Pooja Singh | Child dosing, guardian consent, family account |
| Kamla Devi, 72, no WhatsApp | Older-adult info, SMS fallback |
| Imran Khan, 41, ABHA linked | ABDM M1/M2/M3, Scan & Share |
| Walk-in, no app | Payment link, SMS prescription link |
| Patient with 3 no-shows | Booking limit |

## 4. Critical journeys (each on web, iPhone, iPad, Android)
1. Patient books an online consult, pays with Cashfree (UPI sandbox), receives confirmation.
2. Walk-in via Scan & Share → queue → vitals → consultation with ambient scribe → accept draft → prescription → safety alerts → sign → delivery by WhatsApp and SMS → bill → payment link paid → receipt.
3. Amend a signed prescription; verify QR shows Superseded for v1 and Genuine for v2; void flow.
4. Front desk: doctor running late broadcast; cancel and bulk-reschedule a session.
5. Test order (MRI knee, right) → patient uploads result → doctor reviews.
6. Internal referral grants chart access under own-patients model.
7. Refund (partial) → reconciliation report.
8. New doctor onboarding end to end; unverified doctor cannot sign.
9. Organisation A user cannot see organisation B data anywhere.
10. Offline: queue cached, vitals queued, sync on reconnect.

## 5. Device matrix
Per Build Plan §8.2: small and large iPhone (oldest and latest supported iOS), iPad and iPad Pro with keyboard, low-end Android (2–3 GB RAM, Android 9–11), mid-range Android, 10–11 inch Android tablet, Windows Chrome/Edge (front desk), Mac Safari, mobile browsers.

## 5a. Clinic app checks still to run on real devices
The Clinic app's logic is unit tested and CI bundles both apps' JavaScript for iOS and Android on every pull request (`pnpm --filter @dhc/mobile bundle`, no native build), but these need a person with a device (iPhone, iPad, Android phone and tablet) before release:
- Face ID, Touch ID, Android fingerprint and the passcode fallback unlock the app; it locks after 15 minutes idle (including time in the background) and when opened on a saved session; a device without a screen lock is refused.
- iPad and 10–11 inch tablets show the list and the selected patient side by side, in both orientations and in Split View; phones open the patient on its own screen.
- Flight mode: the saved queue shows with its time; a check-in made offline shows "waiting to sync" and reaches the queue (once, on the web too) when the network returns; a check-in refused meanwhile (visit cancelled on the web) shows the reason and can be discarded.
- Signing out, a clinic admin's sign-out, or opening the app on an expired session removes the saved queue, medicine copy and queued changes from the device.
- Consultation: notes and vitals saved in flight mode sync on reconnect; notes edited on the web meanwhile come back as stale, not overwritten; medicine search falls back to the device copy offline; a penicillin allergy blocks amoxicillin and a warning needs acknowledging before **Sign prescription** is enabled; signing asks for biometrics then the PIN, and a wrong PIN is refused; the two-pane layout on iPad.
- Push permission prompt; the device appears under `GET /push-devices`; a push reaches it once the sender exists (needs the EAS project ID and APNs/FCM credentials).

## 5b. Patient app checks still to run on real devices
- Prescriptions: **View or share PDF** on a signed, a superseded and a void version (the void copy is stamped VOID) opens the PDF in the iOS share sheet / Android chooser, shows a spinner while it downloads, and a clear message when nothing can open it or the download fails; on iOS the copy in the app cache is gone after the sheet closes; on Android a viewer or chat app chosen from the chooser can still read it, and the copy is gone after opening another PDF; on both, it is gone after signing out and after relaunching on an expired session; two quick taps open one sheet; on iPad the sheet appears (its position near the button is not yet set).

## 6. Entry and exit criteria
- **Enter system test:** feature complete on staging, unit/integration green, test data seeded.
- **Exit to pilot:** all PRD v3.0 §12.2 acceptance criteria pass; no open critical or high defects; pen-test critical/high fixed; clinical sign-off on safety pack; simulated clinic day passed.

## 7. Defect severity
| Severity | Definition | Release impact |
|---|---|---|
| Critical | Patient safety, data leak, wrong payment state, signing failure | Blocks release |
| High | Core journey broken without workaround | Blocks release |
| Medium | Workaround exists | Fix within two sprints |
| Low | Cosmetic | Backlog |
