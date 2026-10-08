# Test Plan

**Status:** Draft · **Owner:** QA engineer · **Scope:** web app, Patient app, Clinic app (iPhone, iPad, Android phone and tablet), API and workers, integrations.

## 1. Approach
Testing effort follows risk. Highest risk: safety engine, signing and immutability, tenant isolation, payments (Cashfree), messaging fallback, ABDM consent, scribe consent.

## 2. Test layers and gates
| Layer | Tool | Gate |
|---|---|---|
| Unit (domain, safety, dosage remarks, slots, UHID, bill totals and receipt numbers) | Vitest | Every PR |
| API integration (roles, tenants, errors) | Vitest + test DB | Every PR |
| Tenant isolation suite | Dedicated | Every PR, blocks merge |
| Web end-to-end | Playwright (`apps/e2e`) — built today: invite page, staff web sign-in (cookie, reload, sign-out, 15-minute idle), dashboard invites and authenticator reset, patient register (UHID settings, tags, walk-in registration with duplicate warning, guardian, edit), availability (clinics, consultation types and booking rules; weekly schedule with validation, leave and slot preview; front desk read-only), appointments (book from the patient page, reschedule, cancel with reason, walk-in, overbook switch, doctor starts and completes a consultation), queue (My OPD order with priority tags, waiting time, search and tag filter), waiting-room screen (admin creates and revokes a link; kiosk shows tokens, never names) and consultation (doctor adds a patient-reported allergy and removes it with a reason, records vitals with BMI, writes notes with ICD-10 and free-text diagnoses that autosave and survive a reload, follow-up booking link; front desk records a child's vitals from the queue with the weight reminder and cannot open the notes) and prescription builder (medicine search, free-text line, tapering course, English and Hindi remarks, edited remarks kept, autosave survives a reload, save as template; repeat last and applying and deleting a template), and safety checks (a penicillin allergy blocks amoxicillin with no override and clears when the line is removed; warfarin with ibuprofen warns, is labelled patient-reported, needs a reason to acknowledge and keeps the answer after a reload) and billing (front desk bills a visit with a price-list item and a discount, takes cash then UPI, the bill locks and the receipt opens ready to print; clinic admin adds and reprices an item and reads the day's collections and dues), and signing (the doctor fills the prescription pad and sets a PIN; a wrong PIN is refused; signing locks the lines and opens the PDF; the QR page shows Genuine in English and Hindi with initials only; an amendment signs version 2 and the QR for version 1 shows Superseded; voiding with the PIN shows Void) and the clinic admin's dashboard (today's figures with the no-show rate, a row per day for 7 days; the audit log filtered by area and by staff member, with patients shown by ID only), and the medicine list (the clinic admin links a typed brand to a listed medicine, adds a typed name as a new medicine with its molecule, rejects a name and undoes it, then deactivates, reactivates and edits the clinic's medicine; reference medicines have no actions; a doctor cannot open the page) | Every PR (full suite while it is small); nightly once it grows |
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
