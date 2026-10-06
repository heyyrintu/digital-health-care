# Store Submission Pack

**Status:** Draft · **Owner:** Product owner · **Used by:** `runbooks/store-submission.md`

Placeholders in `<angle brackets>` are filled once the brand name and legal entity are final (ADR 0011).

## 1. App identities
| | Patient app | Clinic app |
|---|---|---|
| Name | `<Brand>` — Book & Health Records | `<Brand>` Clinic |
| iOS bundle ID | `com.<entity>.patient` | `com.<entity>.clinic` |
| Android application ID | `com.<entity>.patient` | `com.<entity>.clinic` |
| Category | Medical | Medical |
| Devices | iPhone, iPad, Android phones and tablets | iPhone, iPad, Android phones and tablets |
| Publisher | `<Legal entity>` (organisation account, D-U-N-S verified) | Same |

## 2. Listing copy (draft)
**Patient app — short description:** Book appointments with your doctor, pay online, and keep prescriptions and reports in one place.

**Patient app — full description:**
- Book in-person or online consultations in a few taps.
- Pay securely with UPI, cards or net banking.
- Get your digitally signed prescriptions and reports instantly.
- Manage your family's health records in one account.
- Link your ABHA and control who sees your records.
- Reminders on WhatsApp and SMS.
Available for patients of clinics using `<Brand>`.

**Clinic app — short description:** Run your OPD from your phone or iPad: queue, consultations, AI notes, prescriptions and billing.

**Clinic app — full description:** For doctors and clinic staff of registered clinics. Live queue, consultation notes with AI voice drafting (with patient consent), prescription builder with safety checks, digital signing, test orders, referrals, payment links and reports. Accounts are created by your clinic.

## 3. Screenshots (synthetic data only)
| Set | Patient app | Clinic app |
|---|---|---|
| iPhone 6.9" / 6.5" | Home, booking slots, payment, prescriptions, family | Queue, consultation, prescription with safety panel, sign, billing |
| iPad 13" | Home, records | Two-pane queue + consultation, scribe draft |
| Android phone | Same as iPhone | Same as iPhone |
| Android tablet (7" and 10") | Home, records | Two-pane layout |

## 4. Privacy answers (to verify against final data flows)
| Data type | Collected | Linked to user | Purpose | Shared with third parties |
|---|---|---|---|---|
| Name, phone, email | Yes | Yes | App functionality | Messaging providers (delivery only) |
| Health and fitness (medical records) | Yes | Yes | App functionality | DSC provider (document hash), AI vendors (Clinic app scribe, under DPA) |
| Payment info | Handled by Cashfree; we store status and amount only | Yes | Purchases of services | Cashfree |
| Audio (Clinic app scribe) | Yes, with consent | Yes | App functionality | Speech-to-text vendor (under DPA) |
| Photos/files | Yes (uploads) | Yes | App functionality | None |
| Device ID / push token | Yes | Yes | App functionality | Push providers |
| Crash data | Yes | No | Diagnostics | Error-tracking vendor |
Tracking across other companies' apps: **No**. Advertising: **No**.

Google Play: Data safety form mirrors the table; health apps declaration completed; account deletion URL: `https://<domain>/account/delete`.

## 5. Review notes (Apple and Google)
- Patients book and pay for real-world medical consultations with licensed doctors; payments are for services delivered outside the app, processed by Cashfree (no digital goods).
- Doctors are verified by registration number before they can issue prescriptions.
- The AI scribe records only after explicit patient consent shown on screen; it drafts notes that the doctor reviews.
- Demo accounts (review environment, synthetic data): Patient `<phone>` with fixed OTP `<code>`; Doctor `<email>` / `<password>` with TOTP disabled for the review account only.
- Account deletion: Profile → Data and privacy → Delete account.

## 6. Permission purpose strings
| Permission | Text |
|---|---|
| Microphone (Clinic app) | Used to record the consultation for AI note drafting, only after the patient agrees. |
| Camera | Used to scan reports, documents and ABDM QR codes. |
| Photos | Used to upload reports and documents you choose. |
| Notifications | Used for appointment reminders, prescriptions and payment updates. |
| Face ID / biometrics | Used to unlock the app and approve prescription signing. |

## 7. Rejection log
| Date | Store | Guideline cited | Fix | Resubmitted |
|---|---|---|---|---|
