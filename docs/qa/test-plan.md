# Test Plan

**Status:** Draft · **Owner:** QA engineer · **Scope:** web app, Patient app, Clinic app (iPhone, iPad, Android phone and tablet), API and workers, integrations.

## 1. Approach
Testing effort follows risk. Highest risk: safety engine, signing and immutability, tenant isolation, payments (Cashfree), messaging fallback, ABDM consent, scribe consent.

## 2. Test layers and gates
| Layer | Tool | Gate |
|---|---|---|
| Unit (domain, safety, dosage remarks, slots, UHID) | Vitest | Every PR |
| API integration (roles, tenants, errors) | Vitest + test DB | Every PR |
| Tenant isolation suite | Dedicated | Every PR, blocks merge |
| Web end-to-end | Playwright | Smoke every PR, full nightly |
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
