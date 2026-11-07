# Build Plan — Web, iOS and Android

Dr. Siddharth Gupta Digital Healthcare Platform · companion to PRD v3.0 (Final) · Oct 6, 2026 · @RINTU

## 1. Summary and key decisions

The demo is approved. We build the production platform as **one TypeScript monorepo** that produces a web app, two mobile apps (each running on iPhone, iPad and Android phones and tablets) and one backend. About 70–80% of code — types, validation, business rules, API client, translations, design tokens — is written once and shared. The plan reaches a clinic pilot in about **7 months** with a team of 9, then store launch.

This document is the engineering companion to PRD v3.0 (Final): the PRD says *what* to build; this says *how*, *in what order* and *who*.

> **Changes since the Oct 6, 2026 Word and PDF editions** (this Markdown is the maintained copy): D12 now spells out the phase count (Phase 0 plus six delivery phases); message links need an OTP or signed-in session before showing prescription or consent content (§6, threat model T23); the next-steps brief now names PRD v3.0 (Final).

| \#  | Decision                       | Choice                                                                                                                                                          |
|-----|--------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------|
| D1  | Codebase strategy              | One monorepo (pnpm + Turborepo), TypeScript end to end                                                                                                          |
| D2  | Web                            | Next.js app: public website, patient web portal, staff dashboard (doctor, front desk, clinic admin), platform console                                           |
| D3  | iOS and Android                | React Native with Expo, one codebase for both platforms and all screen sizes                                                                                    |
| D4  | Number of store apps           | Two apps: **Patient app** and **Clinic app** (doctor, front desk). Built from the same mobile codebase                                                          |
| D5  | iPad and Android tablets       | Fully supported in the Clinic app with a two-pane layout; Patient app adapts but is phone-first                                                                 |
| D6  | Backend                        | Node.js + Fastify modular monolith, PostgreSQL with row-level security, Redis + BullMQ, S3 — all in AWS Mumbai                                                  |
| D7  | API style                      | REST + OpenAPI 3.1, schemas in Zod, typed client generated for web and mobile                                                                                   |
| D8  | Prescription signing on mobile | Server-side signing with a cloud (remote) Class 3 DSC, authorised by doctor PIN + device biometrics. No USB token needed                                        |
| D9  | Offline                        | Read-mostly offline: today's queue, patient summaries and drafts cached on device; writes queued and synced                                                     |
| D10 | Releases                       | EAS Build + Submit for stores, TestFlight and Play testing tracks, web via CI to AWS; over-the-air updates for JavaScript-only fixes                            |
| D11 | Store accounts                 | Owned by the legal entity that operates the platform (see open decision O1)                                                                                     |
| D12 | Delivery                       | Phase 0 foundations plus six delivery phases (7 in all, §9), 2-week sprints, pilot at month 7                                                                    |
| D13 | Payment gateway                | Cashfree Payments on web, iOS and Android: payment links, in-app checkout with UPI Intent, web checkout, refunds, signed webhooks, daily reconciliation (§6.10) |

## 2. Brainstorm: options and trade-offs

Each question below lists the realistic options, what each costs us, and the choice. The deciding factors throughout: a small team, one language across the stack, a doctor who lives on his phone, and a platform that must later serve other doctors.

### 2.1 How many codebases?

| Option                                                          | For                                                                                                                                                        | Against                                                                                                           |
|-----------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------|
| A. Fully native (Swift for iOS, Kotlin for Android) + web       | Best platform feel and performance                                                                                                                         | Three codebases and three skill sets; roughly double the mobile team and time                                     |
| B. Flutter (mobile) + separate web                              | Good UI performance, one mobile codebase                                                                                                                   | Dart differs from the TypeScript backend and web; no shared business rules or types with web                      |
| C. **React Native (Expo) + Next.js in one TypeScript monorepo** | One language everywhere; shared validation, safety rules, API client, translations; large hiring pool in India; mature Expo tooling for builds and updates | Native modules occasionally needed (audio, document scanner); heavy tables are better on web than on React Native |
| D. One Expo app that also renders the web (react-native-web)    | Maximum sharing                                                                                                                                            | Dense staff tables, keyboard-driven front desk and SEO website suffer; web would feel like a phone app            |

**Choice: C.** Mobile and web share packages, not screens. Each surface gets UI that suits it.

### 2.2 One app or two in the stores?

| Option                                                 | For                                                                                                                                   | Against                                                                                                                                 |
|--------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------|
| One app with patient and staff modes                   | One listing to maintain                                                                                                               | Mixed sign-in (OTP vs password + 2FA), bigger download for patients, confusing store listing and privacy labels, harder white-labelling |
| **Two apps: Patient app and Clinic app, one codebase** | Clear listings and reviews; each app requests only the permissions it needs; Patient app can be white-labelled per organisation later | Two store submissions per release (automated by EAS)                                                                                    |

**Choice: two apps from one codebase**, selected by build profile.

### 2.3 Where does each staff role live?

- **Doctor:** Clinic app on phone and iPad is primary; web dashboard for long sessions at a desk. Feature parity on both (PRD §3.1).

- **Front desk:** web dashboard on a desktop is primary (keyboard, printer, waiting-room screen); Clinic app on a tablet as a backup.

- **Clinic Admin and Platform Admin:** web only. Settings-heavy work does not justify mobile screens.

### 2.4 Web framework

Next.js (App Router) for one deployable web app with four areas: public website (server-rendered for SEO), patient portal, staff dashboard, platform console. The demo's React + Tailwind + shadcn components port directly. Alternative considered: separate Vite single-page apps per area; rejected because the public site needs server rendering and four deployables add overhead.

### 2.5 Shared UI between web and mobile?

Share **design tokens** (colours, type scale, spacing, radii), icons and copy; build components natively per platform: shadcn/Tailwind on web, a React Native component kit (NativeWind for Tailwind-style classes) on mobile. Cross-platform UI kits that render both were considered; rejected for V1 because they slow the team down on dense web screens.

### 2.6 Signing prescriptions from a phone

A USB DSC token cannot plug into an iPhone. Options: (a) Aadhaar eSign per prescription — OTP on every prescription, slow at 75 a day and a per-signature fee; (b) **cloud (remote) DSC** held by a licensed provider, signing on the server after the doctor authorises with a PIN and device biometrics; (c) signature image only — legally weak. **Choice: (b)**, with the signing provider behind an adapter so it can change.

### 2.7 Capturing scribe audio on mobile

Stream audio from the app over a secure WebSocket in short chunks; buffer locally if the network drops and upload when back (PRD §6.3). Background recording is allowed only while the consultation screen is active, which keeps app review simple.

### 2.8 Offline approach

Full offline sync (local database replicating server data) was considered and rejected for V1: complex conflict handling for clinical records. Instead: cache today's queue, recent patient summaries and in-progress drafts; queue writes (vitals, notes, check-ins) and sync with clear status. Signing and ABDM always require a connection.

### 2.9 Build, release and updates

Expo Application Services (EAS) builds both apps in the cloud, submits to App Store Connect and Google Play, and ships over-the-air updates for JavaScript-only fixes. Native changes go through full store review. Web deploys from CI on every merge to main after tests pass.

### 2.10 Who owns accounts, data and code

Apple and Google developer accounts, cloud account, domain and the repository are owned by the legal entity that operates the platform, with the clinic as a customer. If Dr. Gupta's clinic must own them instead, white-labelling for other doctors becomes harder. Decision O1 in §11.

## 3. Platforms and roles

Five deliverables run on six device classes. Every role has one primary surface built first and polished most; secondary surfaces reach full parity for daily tasks by launch.

### 3.1 Deliverables

| Deliverable             | Built with                         | Runs on                                   | Users                                                                          |
|-------------------------|------------------------------------|-------------------------------------------|--------------------------------------------------------------------------------|
| Web app                 | Next.js                            | Desktop and mobile browsers               | Public visitors, patients, doctors, front desk, clinic admins, platform admins |
| Patient app             | Expo (React Native)                | iPhone, iPad, Android phones and tablets  | Patients and family account holders                                            |
| Clinic app              | Expo (React Native), same codebase | iPhone, iPad, Android phones and tablets  | Doctors, front desk                                                            |
| Waiting-room display    | Web app route in kiosk mode        | Any TV with a browser or Android TV stick | Clinic waiting area                                                            |
| Backend API and workers | Node.js + Fastify                  | AWS Mumbai                                | All of the above, plus ABDM, WhatsApp, SMS and payment webhooks                |

### 3.2 Role-by-surface matrix

| Role                | Web                           | iPhone      | iPad                   | Android phone | Android tablet  |
|---------------------|-------------------------------|-------------|------------------------|---------------|-----------------|
| Patient             | Full (portal)                 | **Primary** | Supported              | **Primary**   | Supported       |
| Doctor              | Full                          | **Primary** | **Primary** (two-pane) | **Primary**   | Full (two-pane) |
| Front desk          | **Primary**                   | Daily tasks | Full (two-pane)        | Daily tasks   | Full (two-pane) |
| Clinic Admin        | **Primary**                   | —           | —                      | —             | —               |
| Platform Admin      | **Primary**                   | —           | —                      | —             | —               |
| Public / pharmacist | Website, booking, verify page | Opens web   | Opens web              | Opens web     | Opens web       |

"Daily tasks" for front desk on phones = queue, check-in, walk-in registration, payments and the WhatsApp inbox.

### 3.3 Minimum supported versions

- iOS and iPadOS 16 and later (covers the large majority of active iPhones; confirm against store analytics at launch).

- Android 9 (API 28) and later, targeting the latest Android API level that Google Play requires at submission time.

- Browsers: latest two versions of Chrome, Edge, Safari and Firefox; Chrome on Android and Safari on iOS for the patient portal.

### 3.4 Screen-size behaviour

- **Phone (compact):** bottom tab bar, single column, actions in bottom sheets.

- **Tablet (regular width) and iPad:** Clinic app switches to two panes — queue or patient list on the left, consultation on the right — and supports landscape, split view and Slide Over on iPad. Keyboard shortcuts on iPad with a keyboard.

- **Web:** sidebar layout for staff; responsive patient portal; public site mobile-first.

## 4. Architecture and code structure

All clients talk to one API over HTTPS. Business rules — booking, safety checks, signing, tenancy — run only on the server; clients show results. Slow or external work (messages, PDFs, ABDM, imports) runs in background workers so the doctor's screen never waits on a third party.

<img src="media/image1.png" style="width:6in;height:4.63393in" alt="system architecture · 4 clients, 1 backend, 3 data stores" />

system architecture · 4 clients, 1 backend, 3 data stores

The Core API is the one place clinical and billing rules live. Integration services sit behind adapters, so a provider (WhatsApp, SMS, DSC, drug database, AI) can be swapped without touching the rest.

### 4.1 Backend modules

One deployable service (modular monolith) with strict module boundaries, so any module can be split out later if load demands it.

| Module      | Owns                                                                                                           |
|-------------|----------------------------------------------------------------------------------------------------------------|
| identity    | Users, sessions, OTP, password + TOTP, devices, biometric unlock tokens                                        |
| tenancy     | Organisations, clinics, branding, settings, row-level security context                                         |
| scheduling  | Availability versions, slot engine, appointments, queue, tokens, visit timing                                  |
| patients    | Patients, families, tags, UHID, history, allergies, consent                                                    |
| clinical    | Consultations, vitals, assessments, scribe sessions, Ask AI                                                    |
| prescribing | Medicine master, safety engine, prescriptions, versions, signing, PDF                                          |
| orders      | Test orders, results, referrals, attachments                                                                   |
| billing     | Price list, bills, receipts, collections; Cashfree orders, payment links, refunds, webhooks and reconciliation |
| messaging   | Templates, opt-ins, channel cascade, inbox, delivery log                                                       |
| abdm        | ABHA, Scan & Share, care contexts, consents, external records                                                  |
| platform    | Doctor onboarding, verification, usage metering, import jobs                                                   |
| audit       | Append-only audit log, data-rights requests                                                                    |

### 4.2 Monorepo layout

repo/  
apps/  
web/ Next.js: site, patient portal, staff dashboard, platform console, display  
mobile/ Expo: Patient app and Clinic app (two build profiles)  
api/ Fastify API and module code  
workers/ BullMQ workers (same code as api, separate process)  
packages/  
contracts/ Zod schemas and OpenAPI spec (single source of truth)  
api-client/ Typed client generated from OpenAPI (web and mobile)  
domain/ Pure rules: slot engine, dosage remarks, UHID, status machine  
safety/ Safety-engine rules and test cases  
i18n/ English and Hindi strings, date and number formatting  
tokens/ Design tokens: colours, type, spacing, radii  
ui-web/ shadcn and Tailwind components  
ui-native/ React Native components (NativeWind)  
config/ ESLint, TypeScript, Prettier, test presets  
infra/ Terraform for AWS (network, RDS, ECS, S3, CloudFront, WAF)  
docs/ ADRs, runbooks, API guide (see section 11)

The shared rule packages (domain, safety) run on the server as the authority. The apps import the same code only for instant feedback, such as a dosage sentence or a warning preview, before the server confirms.

### 4.3 API conventions

- REST over HTTPS, versioned under /v1, JSON. OpenAPI 3.1 generated from the Zod schemas in packages/contracts.

- Idempotency keys on every write that mobile may retry after being offline (check-in, vitals, payments, notes).

- Cursor pagination; dates stored in UTC, shown in IST.

- One error shape (code, message, field errors) so web and mobile handle errors the same way.

- Incoming webhooks (WhatsApp, SMS, payment, ABDM) are signature-verified and processed by workers.

- Live queue updates over Server-Sent Events on web and WebSocket on mobile; scribe audio uses its own WebSocket.

### 4.4 Data and tenancy

- PostgreSQL 16 on RDS, Multi-AZ in production. Every table carries organisationId; row-level security policies enforce isolation, and each request sets the tenant context from the user's token.

- Prisma for schema and migrations; hand-written SQL allowed for reports, with review.

- S3 buckets per environment: private, encrypted, objects addressed by key and served through short-lived signed URLs (PRD §11.2).

- Field-level encryption for clinical notes, diagnoses, transcripts and signing authorisation material.

## 5. Platform specifics

The shared core is the same everywhere; this section lists what each platform needs beyond it.

### 5.1 Web (Next.js)

| Area                 | Route group                  | Rendering                                         | Notes                                                                                                             |
|----------------------|------------------------------|---------------------------------------------------|-------------------------------------------------------------------------------------------------------------------|
| Public website       | /, /doctor/\[slug\], /verify | Server-rendered, cached at the CDN                | Per-organisation branding and custom domain; SEO metadata and doctor schema markup                                |
| Patient portal       | /app                         | Client-rendered behind login                      | Booking, records, prescriptions, payments, consents; works on mobile browsers for patients without the app        |
| Staff dashboard      | /clinic                      | Client-rendered behind login                      | Doctor, front desk and clinic admin; keyboard shortcuts; print layouts for prescriptions, receipts and day sheets |
| Platform console     | /platform                    | Client-rendered, separate login and IP allow-list | Organisations, doctor verification, usage, health                                                                 |
| Waiting-room display | /display/\[clinic\]          | Kiosk mode, read-only token                       | Current and next tokens only; no names                                                                            |

- Web scribe uses the browser microphone (MediaRecorder) with the same streaming protocol as mobile.

- Printing: browser print with dedicated A4/A5 CSS for prescriptions and receipts; thermal receipt printer support is a Phase 2 option.

- Installable as a Progressive Web App for front-desk PCs so it opens like a desktop app.

- Security headers: strict Content Security Policy, HSTS, no third-party scripts on clinical pages.

### 5.2 iOS and iPadOS

- **Two bundle IDs:** Patient app and Clinic app, each with its own App Store listing, icons and privacy details.

- **iPad (Clinic app):** two-pane layout, landscape and portrait, Split View and Slide Over, external keyboard shortcuts (next patient, sign, search), pointer support. Patient app runs full-screen on iPad with adaptive layouts.

- **Permissions requested only when used, with clear purpose strings:** microphone (scribe), camera (documents, ABDM QR), photo library (uploads), notifications, Face ID (unlock and signing approval).

- **Push:** APNs through Firebase Cloud Messaging; notification categories with action buttons (Confirm, Reschedule) on the Patient app.

- **Deep links:** Universal Links for booking, prescription, payment and consent links sent by WhatsApp and SMS.

- **Secure storage:** tokens in the Keychain; Face ID or passcode to reopen the Clinic app after 15 minutes idle.

- **Files:** document scanner for multi-page reports, PDF viewer, share sheet, AirPrint for prescriptions.

- **Background:** scribe recording continues only while the consultation screen is open; uploads finish with background tasks.

- **Privacy:** App Store privacy labels and a privacy manifest declaring data use; in-app account deletion (Apple requirement).

### 5.3 Android (phones and tablets)

- **Two application IDs**, matching the iOS split, published under one Google Play organisation account.

- **Tablets and foldables (Clinic app):** two-pane layout on large screens, resizable windows, keyboard shortcuts.

- **Permissions at runtime** with rationale screens: microphone, camera, notifications (Android 13+), media access via the system photo picker where possible.

- **Push:** Firebase Cloud Messaging with notification channels (Appointments, Prescriptions, Payments, Security) so patients can mute categories.

- **Deep links:** verified App Links for the same link types as iOS.

- **Secure storage:** Android Keystore; biometric prompt for unlock and signing approval.

- **Scribe:** foreground service with a visible notification while recording, as Android requires for microphone use in the background.

- **Device range:** test on low-memory devices common in India (2–3 GB RAM); keep the Patient app download small; aggressive image compression before upload.

- **Store:** Data safety form, health apps declaration, target the API level Google Play currently requires, app bundles (AAB) only.

### 5.4 What is shared vs per platform

| Layer                                                         | Shared across web, iOS, Android          | Per platform                                         |
|---------------------------------------------------------------|------------------------------------------|------------------------------------------------------|
| Types, validation, API client                                 | Yes                                      | —                                                    |
| Business rules (slot engine, dosage remarks, safety previews) | Yes                                      | —                                                    |
| Translations, date/number formats                             | Yes                                      | —                                                    |
| Design tokens, icons                                          | Yes                                      | —                                                    |
| Screens and components                                        | Mobile screens shared by iOS and Android | Web screens separate                                 |
| Navigation                                                    | Expo Router (mobile)                     | Next.js routing (web)                                |
| Device features                                               | —                                        | Camera, mic, biometrics, push, file system, printing |

## 6. Cross-cutting engineering

These features touch every platform and carry the most risk, so each gets a named owner and a written design (ADR) before its sprint starts.

### 6.1 Sign-in and sessions

| Who                        | First sign-in                                    | Returning                                                                          | Session                                                     |
|----------------------------|--------------------------------------------------|------------------------------------------------------------------------------------|-------------------------------------------------------------|
| Patient                    | Mobile OTP by SMS (WhatsApp OTP optional)        | Biometric unlock on device; OTP on web                                             | Refresh token rotated, up to 30 days on a trusted device    |
| Doctor, front desk         | Password + TOTP authenticator, device registered | Face ID / fingerprint on registered device; password + TOTP on new devices and web | 15-minute idle lock on mobile, 15-minute idle logout on web |
| Clinic and platform admins | Password + TOTP                                  | Same, web only                                                                     | Short sessions; platform console IP allow-list              |

Lost device: staff can revoke a device from the web; tokens on that device stop working immediately.

### 6.2 Prescription signing

1.  Doctor taps Sign on any device.

2.  App asks for biometric confirmation (or signing PIN on web).

3.  Server validates the prescription again (safety engine, completeness, verified doctor) and generates the PDF.

4.  Server asks the cloud DSC provider to sign the PDF hash using the doctor's certificate.

5.  Signed PDF and its hash are stored; prescription is locked; delivery starts.

The doctor's certificate never leaves the provider. Every signing event is in the audit log with device and time.

### 6.3 AI scribe pipeline

- Client captures audio in short chunks (about 1 second), streams over an authenticated WebSocket to the scribe gateway, and buffers locally when offline.

- Gateway forwards to the speech-to-text provider, assembles the transcript with speaker labels, then asks the language model for the structured draft using a versioned prompt.

- Drafts return to the consultation screen; the doctor accepts section by section (PRD §6.3).

- Audio stored encrypted in S3 with automatic deletion after the retention window; transcripts kept with the consultation.

- Provider adapters let us test several vendors on the same recorded (consented, dummy) sessions before choosing.

### 6.4 Offline and poor networks

| Works offline                                                                       | Queued until online                                                  | Needs a connection                                                                               |
|-------------------------------------------------------------------------------------|----------------------------------------------------------------------|--------------------------------------------------------------------------------------------------|
| Today's queue, patient summaries already opened, drafts, templates, medicine master | Check-in, vitals, notes, tags, counter payments, scribe audio upload | Booking new slots, signing, payment links, ABDM, Ask AI, safety checks against the live database |

Queued writes carry idempotency keys and show a clear "waiting to sync" badge. If the server rejects a queued change (for example, a slot already taken), the app explains and offers the fix.

### 6.5 Notifications and deep links

- One notification service decides the channel (WhatsApp, SMS, email, push) per PRD §8.1; apps only register devices and handle taps.

- Every link in a message is a signed, short-lived deep link that opens the app if installed, otherwise the web portal. Prescription and consent content needs an OTP or a signed-in session; a date-of-birth check is enough only for other destinations (for example appointment details or a payment link).

### 6.6 Files and documents

- Uploads go directly from the device to S3 using pre-signed URLs, then the server scans for malware before the file becomes visible.

- Images compressed on device; multi-page photos combined into one PDF on device or by a worker.

- Generated documents (prescriptions, receipts, referral letters) are rendered server-side from versioned HTML templates.

### 6.7 Multi-tenant branding and white-label

- Web: each organisation gets a subdomain or custom domain; theme, logo and text load at request time.

- Mobile V1: one Patient app and one Clinic app; branding (logo, colours, display name) loads after sign-in or from a clinic invite link.

- Phase 2: white-label Patient app builds per organisation from the same codebase using EAS build profiles (own name, icon and store listing).

### 6.8 Accessibility and language

- WCAG 2.1 AA on web; Dynamic Type (iOS) and font scaling (Android) supported; screen-reader labels on every control; 44 px minimum touch targets.

- English and Hindi at launch across all apps; strings live only in packages/i18n so more languages are a translation task, not a code change.

### 6.9 Observability

- Structured logs without patient data; error tracking on web, mobile and backend with release tags; uptime checks on the API and website.

- Mobile: crash reporting, app start time, screen load time, offline-queue size.

- Business dashboards: bookings, completed visits, prescriptions, message delivery and cost, scribe minutes — per organisation.

### 6.10 Payments with Cashfree

All online money movement goes through Cashfree Payments, behind a payments adapter in the billing module so the rest of the code never calls Cashfree directly. Product behaviour is specified in PRD §5.6; this section covers how it is built.

| Surface                                      | Integration                                                                                                                          | Used for                                    |
|----------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------|---------------------------------------------|
| Backend                                      | Cashfree server SDK for Node.js / REST API: create orders, create and cancel payment links, fetch order status, refunds, settlements | Source of truth for every amount and status |
| Patient app (iOS, Android)                   | Cashfree React Native SDK; UPI Intent flow so GPay, PhonePe, Paytm and other UPI apps open directly, plus card and net banking       | Pay at booking, pay dues                    |
| Web (patient portal, website booking widget) | Cashfree JavaScript checkout                                                                                                         | Pay at booking, pay dues                    |
| Clinic app and web dashboard                 | No SDK; staff create bills and send payment links through our API                                                                    | Payment links, refunds                      |
| Webhooks                                     | Cashfree payment, refund and settlement webhooks to a dedicated endpoint                                                             | Confirming payments and refunds             |

Payment flow, step by step:

1.  App asks our API to pay a bill; the API creates a Cashfree order for the exact bill amount (idempotency key = bill id + attempt) and returns a payment session.

2.  App opens Cashfree's checkout (SDK on mobile, JS checkout on web). Card and UPI details never pass through our servers.

3.  On return, the app shows "Confirming payment…" and asks our API for status; the API checks the order with Cashfree.

4.  Cashfree's webhook arrives; the API verifies the signature and timestamp, stores the event, de-duplicates it, and marks the bill Paid. Receipt and messages are sent by workers.

5.  If neither webhook nor status check confirms within the hold time, the attempt is marked Failed or Expired and a booking hold is released.

Build notes:

- The React Native SDK is a native module, so the apps use Expo development builds and EAS builds (not Expo Go). UPI apps must be declared for app detection as Cashfree's guide requires (URL schemes on iOS, package visibility queries on Android).

- Per-organisation Cashfree keys are stored encrypted in the secrets store; each request picks the organisation's keys from the tenant context.

- Webhook endpoint is public but accepts only signed Cashfree events; it responds quickly and hands work to a worker queue.

- Nightly reconciliation job pulls settlements and refunds, matches them to bills, and raises mismatches on the Clinic Admin dashboard.

- Sandbox keys and Cashfree test payment methods in dev and staging; production keys only in production.

- Tests: unit tests for amount and status logic, contract tests against Cashfree sandbox, and end-to-end tests that pay with sandbox UPI and card on iOS, Android and web.

Cashfree onboarding checklist:

- [ ] Merchant account for Gupta Clinic (business KYC, settlement bank account) — start in week 1, as activation can take time.

- [ ] Enable UPI, cards, net banking and wallets; agree transaction fees.

- [ ] Generate sandbox and production API keys; register webhook URLs for staging and production.

- [ ] Confirm website and app details Cashfree requires for activation (domain, policies, refund policy, contact page).

- [ ] Settlement schedule agreed and reflected in the reconciliation report.

## 7. Environments, CI/CD and releases

Every change reaches users the same way: pull request, automated checks, staging, then production. Mobile adds store review and staged rollouts on top.

### 7.1 Environments

| Environment | Purpose                                                               | Data                                     | Mobile builds                                 |
|-------------|-----------------------------------------------------------------------|------------------------------------------|-----------------------------------------------|
| Local       | Developer machines; Docker for Postgres and Redis                     | Seed data                                | Expo development builds                       |
| Dev         | Every merge to main deploys automatically                             | Synthetic data, reset weekly             | Internal distribution builds                  |
| Staging     | Release candidates, QA, clinic user acceptance, store review accounts | Synthetic data only, never real patients | TestFlight and Play internal / closed testing |
| Production  | Live clinic                                                           | Real patient data, India region          | App Store and Play production, staged rollout |

Providers run in sandbox mode outside production: ABDM sandbox, Cashfree sandbox, WhatsApp test number, DSC test certificates.

### 7.2 Continuous integration (every pull request)

1.  Type check, lint, format.

2.  Unit tests (domain, safety, api modules) and component tests.

3.  Contract check: OpenAPI spec regenerated; API client must compile in web and mobile.

4.  Database migration dry-run against a copy of the staging schema.

5.  Tenant-isolation tests: requests from organisation A must never return organisation B's data.

6.  Security scans: dependencies, secrets, container images.

7.  Preview deployment of the web app for review.

Merge needs one approving review and green checks; changes to safety rules, signing, tenancy or auth need a second reviewer.

### 7.3 Web and backend release

- Container images built once, promoted from dev to staging to production unchanged.

- Database migrations run before the new version, written to be backward compatible (expand, then contract) so a rollback never breaks.

- Blue-green deploy on ECS; automatic rollback if health checks or error rates fail.

- Release cadence: weekly to production after staging sign-off; hotfixes any day.

### 7.4 Mobile release

- EAS Build produces iOS and Android binaries for both apps from one commit; EAS Submit uploads them to App Store Connect and Google Play.

- Testing tracks: TestFlight (internal, then the clinic staff as external testers) and Google Play internal then closed testing.

- Production: Play staged rollout (10% → 50% → 100%) and App Store phased release over 7 days, watching crash rate and errors.

- Over-the-air updates (EAS Update) only for JavaScript and asset fixes that do not change app behaviour beyond what was reviewed; native or permission changes always go through store review.

- Cadence: store release every 2 weeks during build, monthly after launch; API stays backward compatible for at least the two latest app versions, with a forced-update screen for anything older.

### 7.5 Versioning and change records

- Semantic versions for apps; build numbers from CI.

- Release notes generated from merged pull requests and reviewed by the product owner.

- Every production release recorded with version, date, migration list and approver (needed for audits).

## 8. Quality, testing and devices

Clinical software is judged by its worst bug, so testing effort follows risk: the safety engine, signing, tenancy and billing get the most.

### 8.1 Test layers

| Layer             | Tool                                     | What it covers                                                                     | Gate                                |
|-------------------|------------------------------------------|------------------------------------------------------------------------------------|-------------------------------------|
| Unit              | Vitest                                   | Domain rules, safety rules, dosage sentences, slot engine, UHID                    | Every PR                            |
| API integration   | Vitest + test database                   | Each endpoint with roles, tenants and error cases                                  | Every PR                            |
| Tenant isolation  | Dedicated suite                          | Cross-organisation reads and writes through every endpoint and file link           | Every PR; blocks merge              |
| Web end-to-end    | Playwright                               | Booking, consultation to sign, front desk day, admin settings                      | Every PR (smoke), nightly (full)    |
| Mobile end-to-end | Maestro                                  | Same journeys on iOS simulator and Android emulator, phone and tablet              | Nightly and before each store build |
| Clinical safety   | Rule test pack                           | Every rule in PRD §6.5 with positive and negative cases, signed off by a clinician | Any change to safety rules          |
| Accessibility     | axe (web), screen-reader passes (mobile) | Contrast, labels, focus, Dynamic Type                                              | Before each release                 |
| Performance       | k6 load tests, app profiling             | API at 10× expected peak; app start and list scrolling on low-end Android          | Before pilot and launch             |
| Security          | External penetration test                | Web, both apps, API, tenant isolation                                              | Before pilot; yearly                |

### 8.2 Device matrix

A physical device lab of about eight devices, plus a cloud device service for wider coverage before each release.

| Class                    | Minimum to test                                                                           |
|--------------------------|-------------------------------------------------------------------------------------------|
| iPhone                   | One small screen (SE size), one current Pro Max size, oldest supported iOS and latest iOS |
| iPad                     | One iPad (10th gen class) and one iPad Pro, with keyboard, both orientations, Split View  |
| Android phone, low end   | 2–3 GB RAM device on Android 9–11                                                         |
| Android phone, mid range | Popular Indian brand model on recent Android                                              |
| Android tablet           | One 10–11 inch tablet                                                                     |
| Web                      | Chrome and Edge on Windows (front desk PCs), Safari on Mac, mobile browsers               |

### 8.3 Performance budgets

- Patient app cold start under 3 s on a mid-range Android; Clinic app queue visible under 1.5 s from unlock on a warm start.

- API p95 under 400 ms; prescription PDF under 5 s; scribe draft under 30 s for a 10-minute consultation.

- Patient app download under 40 MB on Android.

### 8.4 Clinical acceptance

Before pilot, Dr. Gupta and front-desk staff run a full simulated clinic day on staging (dummy patients) across web, iPhone, iPad and Android, using the acceptance criteria in PRD v3.0 §12.2. Issues found are triaged as blocker, must-fix before launch, or later.

## 9. Delivery plan

Web comes first because it unblocks the clinic's front desk and gives the doctor a full workflow early. Since October 2026 (owner decision, §9.1 Priority) mobile no longer overlaps: the apps resume on the same API once the web app works well, and integrations are built on the web first. The pilot can start on the web alone; the apps join when their store builds are approved.

<img src="media/image2.png" style="width:6in;height:3.05357in" alt="delivery timeline · 7 phases over 32 weeks" />

delivery timeline · 7 phases over 32 weeks

Week 1 starts when the team is hired and the open decisions in §11 are closed. The timeline above shows the original overlap between phases 1, 2 and 3, which kept the plan at about 7 months to pilot. With mobile parked until the web app works, the store launch (phase 6) moves later by about the length of phase 2; a smaller team adds a further 2 to 3 months.

### 9.1 Phases and exit criteria

| Phase                  | Weeks | Scope                                                                                                                                                                                                                                                                       | Exit criteria                                                                                |
|------------------------|-------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------|
| 0 Foundations          | 1–4   | Monorepo, CI/CD, AWS dev and staging, design tokens, auth (OTP, password + TOTP), tenancy with row-level security, audit log, ADRs; start DLT, WhatsApp, Apple, Google, ABDM sandbox, DSC provider and Cashfree merchant KYC paperwork; choose drug database and AI vendors | A logged-in user in organisation A cannot see organisation B; CI green; accounts applied for |
| 1 Core clinic on web   | 5–12  | Scheduling and slot engine, patients, families, tags, UHID, queue tabs, front desk, consultation, vitals, prescription builder, safety engine, cloud DSC signing, PDF, billing and counter payments, clinic admin settings                                                  | A full simulated clinic day runs on the web dashboard                                        |
| 2 Mobile apps          | 9–18  | Clinic app (phone and iPad/tablet two-pane, biometrics, offline queue) and Patient app (onboarding, family, booking, records, prescriptions, consents) on iOS and Android                                                                                                   | Both apps on TestFlight and Play internal testing; doctor completes a day on iPad and phone  |
| 3 Integrations and AI  | 13–22 | Messaging cascade and inbox, Cashfree payments (links, in-app and web checkout, refunds, reconciliation), ABDM M1, Scan & Share and M2, AI scribe, Ask AI, assessments, orders, referrals, review links, multi-doctor onboarding and platform console, import tool          | Every PRD §11.2 acceptance criterion passes on staging                                       |
| 4 Hardening and review | 23–26 | Penetration test and fixes, load test, accessibility, ABDM review submission, trial migration from the current EMR, store listings and review                                                                                                                               | No open critical or high findings; store builds approved; migration dry run clean            |
| 5 Clinic pilot         | 27–30 | Production go-live at the clinic with real patients; parallel run with the current EMR for 2 weeks, then cut-over                                                                                                                                                           | Clinic runs fully on the platform for 2 weeks with no blocker issues                         |
| 6 Store launch         | 31–32 | Public App Store and Play release, patient onboarding campaign at the clinic, ABDM M3 (fetch records) in the following weeks                                                                                                                                                | Apps live; first onboarded patients using booking and prescriptions                          |

**Priority (October 2026, owner decision):** the web app comes first. Work goes to the web until it runs a clinic and serves patients end to end: the patient portal at `/app` (sign-in, consents, family, booking, appointments, prescriptions, tests, privacy), then the public website (doctor pages, booking, verification), then the Phase 3 features on web. The mobile apps are parked: their code stays merged and checked in CI, and the Phase 2 exit (store builds and a doctor's day on iPad and phone) resumes once the web app works well.

**Progress (October 2026):**

| Phase | State |
|---|---|
| 0 Foundations | Done: monorepo, CI, staff and patient sign-in, tenancy with row-level security, audit log, ADRs. |
| 1 Core clinic on web | Exit criterion met: the full simulated clinic day passes in the browser (`apps/e2e/tests/clinic-day.spec.ts`). Built: scheduling and slots, patients, tags and UHID, queue and waiting-room screen, consultation and vitals, prescription builder, safety engine, signing with PDF and QR, billing and counter payments, clinic admin dashboard, audit log, medicine list, staff devices, clinic settings (chart model, safety tuning, upload limits), patient merges, follow-ups and automatic no-shows, idempotency keys and live queue updates over server-sent events. |
| 2 Mobile apps | Parked (web first, see Priority above): code for both apps is merged. Built: shared React Native components (`@dhc/ui-native`), secure sessions and sign-in; Clinic app queue with the two-pane iPad layout, idle lock with biometrics, offline queue and check-in, push registration, and the consultation (notes, vitals, prescription with safety alerts, signing); Patient app onboarding and consents, family, booking, appointments, prescriptions with the signed PDF, privacy, and tests with result upload and viewing (Phase 3 test orders). Exit criterion still open: store builds on TestFlight and Play internal testing (needs store accounts, the EAS project ID and push credentials) and a doctor's day on iPad and phone. |
| 3 Integrations and AI | In progress: platform console API and web screens (operators with password and authenticator from allowed networks only, a separate token audience and its own web session, organisations with clinic and staff counts, onboarding of an organisation with its first clinic and admin invite shown once, the doctor verification queue and verifying from it, usage per organisation, system health with the API, the database and background queue counts; cross-organisation reads only through aggregate database functions, ADR 0016); test orders (web, API and the Patient app) with clinic admin editing of the test catalogue. Web first: the patient portal at `/app` has sign-in, consents, family, appointments, booking, privacy, prescriptions with the signed PDF, and tests with result upload; the public website has doctor pages at `/doctor/<address>` with booking into the portal (ADR 0017) and a home page with a doctor directory; clinic branding (name, tagline, colour, logo) shows on doctor pages and the portal. Custom domains wait for hosting. Referrals on the web: internal and outside referrals from the consultation, a Referrals page with Sent → Seen → Closed, and chart access for the receiving doctor while an internal referral is open; a signed referral letter PDF with QR verification; optional generic WhatsApp availability notices are implemented behind a disabled flag. Documents on the web: a clinic library of reusable sheets, sharing sheets and one-off documents with a patient, and a Documents page in the portal; optional generic WhatsApp availability notices are implemented behind a disabled flag. Console not started: suspending an organisation (pending owner decision O8, §11.2). Messaging first increment (4 November 2026): patient OTP adapter for Meta WhatsApp Cloud API, with configuration validation, bounded requests and safe delivery failure handling; live delivery still needs Meta credentials and an approved authentication template. OTP delivery tracking is built: verified Meta status callbacks, sanitized durable receipt inbox, background processing and a tenant-scoped clinic-admin delivery log. Appointment notifications are built behind an off-by-default flag: explicit number-holder opt-in, transactional confirmation/24-hour-reminder outbox, signed STOP handling, stale-recipient/booking suppression and single-attempt sending with uncertainty tracking. Generic record availability notices for signed prescriptions/referral letters and shared documents are built with independent opt-in and one-hour authenticated navigation links (ADR 0020). General notification cascade and chat inbox remain unbuilt; SMS is deferred. Cashfree collection for existing bills is implemented behind an off-by-default flag (ADR 0021); refund requests/statuses, an append-only ledger and vouchers are implemented behind a separate disabled flag (ADR 0022); read-only nightly settlement reports and admin review are implemented behind a separate disabled flag (ADR 0023); prepaid in-person web booking is implemented behind a separate disabled flag (ADR 0024); native and telemedicine checkout remain pending. Not started: ABDM, AI scribe, Ask AI, assessments, review links, import tool. |
| 4 to 6 | Not started. |

### 9.2 Sprint rhythm

- Two-week sprints (16 sprints to launch): planning on day 1, demo to Dr. Gupta every second Friday, retrospective at the end.

- Each sprint ships to staging; a store build goes to testers every sprint once phase 2 starts.

- A definition of done applies to every feature: works on web and both mobile platforms where the role matrix says so, tests written, translations added, audit events logged, documentation updated.

### 9.3 Team

| Role                            | Count | Main responsibilities                                                            |
|---------------------------------|-------|----------------------------------------------------------------------------------|
| Tech lead / architect           | 1     | Architecture, ADRs, code review of risky areas, security owner                   |
| Backend engineers               | 2     | API modules, workers, integrations (ABDM, messaging, payments, DSC, AI)          |
| Web engineer                    | 1     | Next.js app: staff dashboard, patient portal, website, platform console          |
| Mobile engineers                | 2     | Expo apps for iOS and Android, tablets, offline, device features, store releases |
| Product designer                | 1     | Design system, flows for all platforms, usability sessions with the clinic       |
| QA engineer                     | 1     | Test plans, automation (Playwright, Maestro), device lab, release sign-off       |
| DevOps (part-time)              | 0.5   | AWS, Terraform, CI/CD, monitoring, backups                                       |
| Product owner / project manager | 1     | Backlog, vendor coordination, compliance tracking, clinic liaison                |

Advisors on call: a clinician to review safety rules and the scribe, and a healthcare lawyer for consent, DPDP and ABDM documents.

### 9.4 Who decides what

| Decision                        | Responsible   | Approves             | Consulted        |
|---------------------------------|---------------|----------------------|------------------|
| Scope and priorities            | Product owner | Platform owner (you) | Dr. Gupta        |
| Architecture and vendors        | Tech lead     | Platform owner       | Engineers        |
| Clinical rules and templates    | Product owner | Dr. Gupta            | Clinical advisor |
| Release to production           | QA engineer   | Tech lead            | Product owner    |
| Security and privacy exceptions | Tech lead     | Platform owner       | Lawyer           |

## 10. Store readiness, costs and risks

App review for healthcare apps is stricter than for ordinary apps, and the paperwork has long lead times, so it starts in week 1, not at the end.

### 10.1 App Store (Apple) checklist

- [ ] Apple Developer Program enrolled as an **organisation** (needs a D-U-N-S number). Apple's guidelines expect apps in regulated fields such as healthcare to be submitted by the legal entity providing the service, not an individual.

- [ ] Two app records (Patient, Clinic) with names, icons, screenshots for iPhone and iPad, and support and privacy-policy URLs.

- [ ] Privacy labels and privacy manifest completed for each app.

- [ ] In-app account deletion available in the Patient app.

- [ ] Review notes: demo accounts for patient and doctor on staging-like review data, explanation of telemedicine, OTP bypass for the reviewer number, and how the scribe consent works.

- [ ] Microphone, camera and photo purpose strings written in plain language.

- [ ] Export compliance answers (standard encryption only).

### 10.2 Google Play checklist

- [ ] Play Console **organisation** account (D-U-N-S verification); Google increasingly expects health apps to be published by organisations.

- [ ] Two app listings with phone and tablet screenshots.

- [ ] Data safety form and health apps declaration for each app.

- [ ] Target API level as required by Play at submission time; app bundles signed with Play App Signing.

- [ ] Foreground-service declaration for microphone use (scribe) in the Clinic app.

- [ ] Account deletion link (in-app and web) declared.

- [ ] Closed testing with clinic staff before production.

### 10.3 Costs

One-off and yearly items below are known list prices or vendor quotes still to collect. Team cost is a rough planning estimate for India and should be replaced by real quotes.

| Item                                                                                        | Type                      | Estimate                                                            |
|---------------------------------------------------------------------------------------------|---------------------------|---------------------------------------------------------------------|
| Team of about 9 for 8 months (in-house or agency)                                           | Build                     | Rough planning range ₹1–1.5 crore; get two or three quotes          |
| Apple Developer Program                                                                     | Yearly                    | US\$99                                                              |
| Google Play developer account                                                               | One-off                   | US\$25                                                              |
| Expo EAS paid plan (cloud builds, submit, updates)                                          | Monthly                   | Check current pricing; optional if builds run on our own CI         |
| Mac build machine or cloud Mac minutes (iOS builds)                                         | One-off or monthly        | Covered by EAS cloud builds if used                                 |
| Physical device lab (about 8 devices)                                                       | One-off                   | Approx. ₹3–5 lakh                                                   |
| Cloud device testing service                                                                | Monthly                   | Approx. ₹10,000–25,000                                              |
| AWS (dev, staging, production)                                                              | Monthly                   | Approx. ₹20,000–40,000 during build; production as in the cost note |
| Penetration test                                                                            | Before pilot, then yearly | Approx. ₹1–3 lakh for web, two apps and API                         |
| Drug database licence, AI scribe usage, WhatsApp, SMS, Cashfree transaction fees, cloud DSC | Monthly / per use         | Vendor quotes during phase 0                                        |
| Legal review (consent, privacy, ABDM, AI)                                                   | One-off                   | Approx. ₹50,000–1.5 lakh                                            |

### 10.4 Risks

| Risk                                                          | Likelihood | Impact                    | Mitigation                                                                                                            |
|---------------------------------------------------------------|------------|---------------------------|-----------------------------------------------------------------------------------------------------------------------|
| App review rejection (health data, telemedicine, scribe)      | Medium     | Launch slips 1–3 weeks    | Organisation accounts, clear review notes, submit a TestFlight external build early to surface issues                 |
| ABDM review takes longer than planned                         | Medium     | ABDM features launch late | Start sandbox in week 1; launch with ABDM behind a feature flag                                                       |
| Cloud DSC provider integration harder than expected           | Medium     | Signing blocked           | Shortlist two providers in phase 0; keep the signing adapter thin; fallback to visible-signature mode only in staging |
| Mobile team stretched across two apps and four device classes | High       | Quality drops on tablets  | Shared component kit, tablet layouts designed up front, Maestro tests on tablets every night                          |
| Low-end Android performance                                   | Medium     | Patient drop-off          | Performance budget in CI, testing on 2–3 GB RAM devices from sprint 1                                                 |
| Offline sync conflicts                                        | Low        | Duplicate or lost entries | Limited offline scope (§6.4), idempotency keys, clear sync status                                                     |
| Data migration from current EMR is partial                    | Medium     | Doctor lacks history      | Request export early; fallback plan in PRD §9.5                                                                       |
| Hiring delays                                                 | Medium     | Whole plan shifts         | Start with tech lead and one mobile and one backend engineer; agency for overflow                                     |

## 11. Documentation, open decisions and next steps

"Document everything" means a small set of living documents with named owners, kept next to the code where possible, so they stay true as the product changes.

### 11.1 Documentation set

| Document                                                                                     | Owner                            | Lives in                                        | Updated when                     |
|----------------------------------------------------------------------------------------------|----------------------------------|-------------------------------------------------|----------------------------------|
| PRD (v3.0 Final and later)                                                                   | Product owner                    | Claude Docs                                     | Scope changes                    |
| Build plan (this document)                                                                   | Tech lead                        | Claude Docs                                     | End of each phase                |
| Architecture decision records (ADRs), one per decision D1–D12 and each new one               | Tech lead                        | docs/adr in the repo                            | Before a decision is implemented |
| API reference                                                                                | Generated                        | OpenAPI spec, published to the developer portal | Every merge                      |
| Data dictionary                                                                              | Backend lead                     | docs/data in the repo                           | Every migration                  |
| Safety rule catalogue with clinical sign-off                                                 | Product owner + clinical advisor | docs/safety                                     | Any rule change                  |
| Security and privacy pack (threat model, data flows, DPDP record of processing, vendor DPAs) | Tech lead + lawyer               | Shared drive, restricted                        | Quarterly and on vendor change   |
| Test plan and release checklist                                                              | QA engineer                      | docs/qa                                         | Each release                     |
| Runbooks (deploy, rollback, incident, backup restore, key rotation, store submission)        | DevOps                           | docs/runbooks                                   | After every incident or drill    |
| Store submission pack (listings, screenshots, review notes, privacy answers)                 | Product owner                    | Shared drive                                    | Each store release               |
| User guides: doctor, front desk, clinic admin, patient FAQ                                   | Product designer                 | Help centre in the web app                      | Each feature release             |
| Release notes and change log                                                                 | Product owner                    | Web app and store listings                      | Each release                     |

Rule: a pull request that changes behaviour updates the relevant document in the same pull request.

### 11.2 Open decisions to close in week 1

- [ ] **O1** Which legal entity owns the Apple and Google accounts, AWS, domain and code (your company vs the clinic). Affects white-labelling for other doctors.

- [ ] **O2** Build team model: in-house hires, agency, or a mix.

- [ ] **O3** Cloud DSC provider (shortlist two).

- [ ] **O4** Drug database and AI scribe vendors (from PRD open decisions).

- [ ] **O5** WhatsApp decided (4 November 2026): Meta WhatsApp Cloud API directly; WhatsApp-only delivery for now. SMS provider and fallback deferred. Meta account credentials and an approved authentication template are still required. Payment gateway decided: Cashfree.

- [ ] **O6** Whether front desk needs the Clinic app at launch or web only for V1.

- [ ] **O7** Confirm Dr. Gupta's specialty pack (orthopaedics) and pilot start date.

- [ ] **O8** Suspending an organisation from the platform console: who may suspend (any operator, or with a second operator's approval), what happens to its staff sessions, patient bookings and patients' access to their prescriptions while it is suspended, and whether and how it can be undone.

### 11.3 Next steps (first two weeks)

1.  Close O1 and O2; start hiring or agency selection with this document and PRD v3.0 (Final) as the brief.

2.  Apply for D-U-N-S, Apple and Google organisation accounts, DLT registration, WhatsApp Business verification and ABDM sandbox access — these have the longest lead times.

3.  Request a data export from the current EMR vendor.

4.  Tech lead writes ADRs for D1–D12 and sets up the monorepo, CI and dev environment.

5.  Designer turns the approved demo into the production design system for web, phone and tablet.

6.  Book the first demo with Dr. Gupta for the end of sprint 2.


### Implementation update — 2026-11-04: generic WhatsApp record notices

Implemented locally after appointment notices: record-specific opt-in, transactional delivery intents for newly signed prescriptions/referral letters and newly shared documents, generic approved-template transport, expiring authenticated web links, portal referral letters and delivery log categories (ADR 0020). No old-record backfill. Sending stays off until Meta templates, callbacks, Redis workers and shared link secret are configured and a controlled live pilot passes. This does not complete all messaging: campaigns, attachments, cancellation notices, guardian fallback and other plan items remain separate work.


### Implementation update — 2026-11-04: Cashfree collection for existing bills

Built the first end-to-end payment collection flow: a clinic-specific merchant adapter, server-priced remaining balance, one active order per bill, hosted checkout through a signed pay-only web link, authenticated staff check/close controls, raw-body signature verification, atomic sanitized event/receipt processing, and receipt/collection-report inclusion. Bill edits and counter collection pause while payment is open. Callback retries and server checks cannot create duplicate receipts. Payment/account/amount/currency mismatches require review. Features remain disabled pending configuration and sandbox acceptance.

Remaining after the subsequent payment increments: native/telemedicine checkout and automatic delivery of payment links/receipts. These are not claimed complete by the collection increment.


### Implementation update — 2026-11-04: Cashfree refunds

Implemented admin-only partial/full refunds of verified Cashfree payments, one unresolved app request per payment, immutable amount/reason/IDs, explicit recovery with the same request and provider idempotency key, signed refund callbacks and read-only checks. A confirmed refund posts once to an append-only ledger with an RF-numbered printable voucher. Gross bill payments and the original receipt stay fixed; refunded/net-collected totals are separate and do not make the bill due again. Provider/dashboard refunds for the original credited transaction are imported before new requests; unrelated or excessive refunds require review. Daily reports include posted refunds and negative net collection when appropriate. New requests are disabled by default pending a real sandbox pilot.

Settlement reporting and acknowledgement have now shipped locally (below). Prepaid in-person web booking is implemented below. Native/telemedicine checkout and automatic payment messages remain outstanding.


### Cashfree settlement reconciliation increment — 5 November 2026

Implemented, disabled by default: durable manual/nightly reports per clinic merchant, rolling seven-day coverage, bounded complete pagination of settlements/PG events/settlement breakdown, exact signed paise, gross/fee/tax/adjustment/net separation, matching against immutable receipt/refund entries, ID/account/currency/amount conflicts, missing records, and clinic-admin history/review in English/Hindi. Completed snapshots are append-only; reason-coded acknowledgement is audited and changes no financial balance or source flag. Database leases and five attempts recover queue/provider failures and fence stale workers. Separate saved reports remain readable when disabled. See ADR 0023 and the Cashfree runbook.

Still pending: live Cashfree report/sandbox validation and agreed settlement schedule, bank statement matching/import, automated discrepancy resolution, native/telemedicine checkout and automatic payment link/receipt messaging. The wider Phase 3 integration plan is not complete.


### Prepaid in-person web booking increment — 5 November 2026

Implemented behind `CASHFREE_PREPAID_BOOKING_ENABLED=false`: supporting-client options, atomic pending slot + frozen standard-fee bill + original order reservations, stable UUID recovery, family/dependant ownership, checkout links, explicit check/closure, verified receipt + confirmation in one transaction, and captured clinic manual/automatic approval rules. Durable API expiry checks release only after verified provider closure; uncertainty retains the hold. Late/past-slot success records a receipt and review without restoring the appointment. Database guards prevent unpaid confirmation/check-in/no-show, quote edits, replacement collection and moving prepaid appointments. Patient and staff screens are English/Hindi. See ADR 0024.

Still pending: real sandbox activation/race/refund verification, native SDK checkout, telemedicine identity/consent and booking, automatic payment-link/receipt messaging and automatic refunds. The wider Phase 3 plan remains in progress.


### Owner priority update — 5 November 2026: finish the web version first

Native app development/builds and native Cashfree checkout are paused at the owner's request. Preserve existing mobile work; do not advance native SDK, packaging or store-submission tasks while this priority is in force. Continue the web application and the API/background work it needs. Credentials and live-provider activation remain deferred; they do not prevent local implementation and synthetic validation.

Next web work, in order:

1. Complete the web payment communication journey: opted-in Meta WhatsApp payment-link notices and authenticated patient access to receipts, followed by receipt availability notices. Reuse the durable notification/STOP/ownership controls; do not add SMS or expose a receipt through a pay-only link.
2. Finish payment recovery and review in the web dashboards, then verify patient booking/payment/refund/receipt journeys and staff/admin workflows on narrow and desktop layouts. Keep implementation completion separate from real-provider acceptance.
3. Continue the remaining web backlog: messaging inbox, assessments/review links, import tooling, and the web portions of telemedicine, ABDM and AI features. Resolve their existing provider/product decisions when needed; do not mark these complete merely because core payment flows pass.
4. Perform web release acceptance and, after credentials are supplied, real Meta/Cashfree sandbox checks and deployment preparation.

Native checkout is no longer the next task. Resume native work only when the owner asks. This changes delivery order, not the recorded implementation status of the wider Phase 3 plan. Do not open a PR unless the owner changes that instruction.


### Full requirements audit — 5 November 2026

The [web-first plan-to-code audit](../reviews/web-plan-audit-2026-11-05.md) compares all 24 PRD pages and this maintained plan with the current local implementation. It supersedes the narrower payment-only next-step list and the older branch audit's implementation status. The planned web product is not complete: patient rescheduling/profile/data-rights/general-record/payment gaps, the conversational inbox, assessments/reviews, AI, ABDM, import, production storage/cloud signing, deployment and hardening remain open. Some adapters are built but await credentials/real acceptance; other work still requires implementation. Native development stays paused and SMS stays deferred under the owner's decisions. Use the audit's evidence and revised work order; passing local checks does not close all staging/pilot exit criteria.


### Patient finance and financial notices — 5 November 2026

Completed locally: web Payments and receipts, current family/guardian/merged-history ownership, bounded bill/receipt pagination, exact-balance checkout/recovery, original receipt view/print/PDF save, and separate confirmed-refund supplements. Original staff receipts and ledger totals remain unchanged by refunds. Independent payment-message consent now feeds transactional order/receipt/refund availability events, generic signed-in expiring navigation links, sender/source/contact/consent rechecks, STOP and at-most-one send authorization. New notices default off under `WHATSAPP_PAYMENTS_ENABLED=false`; approved Meta template/language, shared link secret, workers and real acceptance follow later. See ADR 0025.

Validation: 52 web/API/worker/shared/browser-check tasks, 100 targeted financial/messaging integration tests with all 42 migrations on a fresh database, and all 65 local web browser tests passed. These are local/synthetic checks, not live-provider or staging/pilot acceptance.

This closes the first financial web slice in the requirements audit; it does not complete the full web product. Continue with patient self-rescheduling/profile/data rights/general records, inbox/operational workflows, and the remaining assessed web features/hardening. Cloud DSC and AI vendor choices remain open inputs; credentials can be added later. Native development remains paused and no PR is opened.

### Patient web self-rescheduling increment — 5 November 2026

Implemented ADR 0026: family-owned appointment detail and atomic new-time replacement, preserving doctor/clinic/type/reason, honoring clinic cutoffs and patient availability rules. English/Hindi web flow recovers an interrupted response with the same attempt key and freezes choices while its outcome is uncertain. Concurrent requests create at most one replacement. Merged history moves to the live patient. Billed/prepaid appointments require clinic assistance. Existing notification/consent rules apply independently; native work remains paused.

This closes the audited self-rescheduling slice locally. Profile/contact verification, generic patient records, data-rights requests, inbox/template administration and the remaining clinical/integration/release items stay open.

Validation: all 42 API integration suites passed (594 passed, one Redis-dependent queue-health test skipped because TEST_REDIS_URL was not configured). After the final consultation-policy lock, 37 focused booking/prepaid/finance integration tests passed. The complete 66-test browser suite passed; interrupted-response rescheduling was additionally repeated at 390px and 1280px against the final API build (both passed). All 52 scoped web/API/worker/shared checks passed, followed by 16 API/browser check tasks after the safeguard. Formatting and diff checks passed. These are local synthetic checks; live-provider and deployment acceptance remain open.


### Owner update — defer cloud DSC and AI (5 November 2026)

The owner has deferred both cloud DSC provider selection/integration (O3) and AI speech/model provider selection/integration (O4) for now. Keep production cloud signing, ambient/dictation scribe and Ask AI outside the current work queue until resumed. Existing test-key signing remains a local/test capability; this deferral does not make it production DSC. The drug-database choice and clinical safety sign-off remain separate open items. Native app work and SMS remain paused/deferred under the earlier decisions.

Current web priorities: patient profile/contact verification; general patient record management; data-rights download/correction/account-closure workflows; conversational WhatsApp inbox and remaining notification/template administration; bulk clinic session operations; assessments/reviews and the confirmed specialty pack; import/accountant export; web telemedicine and ABHA/ABDM; production storage/scanning, deployment, monitoring, hardening and release acceptance. Patient dues/receipts, financial availability notices and eligible unbilled/non-prepaid self-rescheduling have been implemented locally and must not be counted as missing. Real Meta/Cashfree activation and sandbox checks follow when credentials are supplied. This is a delivery-order change, not a claim that deferred features are built or all launch criteria are met.

### Patient profiles and verified phone changes — 5 November 2026

Implemented ADR 0027: family-owned web profile editing with version checks, contact/emergency details and private validated photos; patient-reported medical basics marked unverified; doctor/chart-permission confirmation preserving original entries; version-bound blood-group confirmation. Verified phone changes require purpose-bound codes on both old/new numbers, durable request recovery, expiry/attempt/rate limits and current ownership/access checks. A transfer affects the selected adult and dependants in the current clinic, preserves IDs/history, ends affected patient sessions and requires normal sign-in/consents on the destination. Other adults/clinics and staff identities remain unchanged. Existing clinic records on the new number and lost-number identity checks require clinic assistance. Production storage, remote identity proofing and automatic account/record merges are not supplied by this increment. No native work, PR or deployment.

Next core web work: general patient record management and data-rights export/correction/account-closure workflows. Inbox/notifications, bulk operations, assessments/reviews, imports, online consultations, ABDM and release infrastructure/acceptance remain open. Cloud DSC and AI remain deferred.

Validation: all 43 migrations applied to fresh disposable databases; 128 affected API integration tests across eight suites passed; 52 scoped web/API/worker/shared checks passed; all 69 web browser tests passed, including clinic-side blood/allergy confirmation. After the final immediate-name refresh fix, 15 web/browser check tasks and both 390px/1280px profile/phone-change browser scenarios passed again. Formatting and diff checks passed. Real Meta delivery, production storage/scanning and staging acceptance remain separate.

### Patient records, doctor sharing and retention — 5 November 2026

Implemented ADR 0028: My records with five categories, encrypted title/note, document dates, same-patient appointment/order links, bounded paging, editable unused metadata and up to ten uploads per batch. Photo pages are flattened locally and assembled as a checked multi-page PDF. UUID/source-hash recovery preserves original uploads after interrupted responses. Named active clinic doctors receive authenticated, expiring/revocable fragment links; file grants do not open a restricted chart. Review and actual treating-visit use are explicit, revision-bound actions. Used records are retained/frozen by database guards; patients may hide/restore them. Unused deletion and unfinished-upload expiry use a durable leased API sweep that retries storage failures. Consent withdrawal closes unused grants while preserving clinical care copies.

This closes the agreed core general-record-management increment locally. Anonymous/external-doctor links, automatic new-upload messages, production storage/scanning/backup controls and staging acceptance are not supplied by it. Next: patient data download, correction requests and account closure/retention workflows. Native work stays paused; DSC/AI stay deferred; no PR or deployment.

Validation: all 45 migrations applied to disposable databases, including grantor backfill; 72 affected API integration tests across five suites passed; all 52 scoped web/API/worker/shared checks passed; all 72 web browser tests passed. The new browser cases cover 390px/1280px combined upload/share/clinical-use/hide/restore and interrupted raw-upload recovery/deletion. Formatting and diff checks passed. These are local synthetic checks, not production storage/scanner, provider, backup or clinic acceptance.

### Patient data rights and clinic account closure — 5 November 2026

Implemented ADR 0029 locally: a consent-independent rights page; bounded private patient-facing ZIP downloads with owned merged history and file-integrity checks; encrypted correction/erasure-review requests with immutable events and revision-bound decisions; validated profile correction; clinical assignment/redaction and real correction evidence; policy-based retention review; and purpose-bound OTP clinic-account closure. Closure revokes current-clinic patient access/consents/preferences/shares, closes owned family profiles and queues eligible personal uploads/photos for deletion while preserving care/payment records and appointments. Ordinary sign-in/phone changes cannot reclaim closed profiles.

This closes the core self-service data-rights increment, not every formal/manual access or retention exception. Private clinician notes/drafts, oversized exports, identity disputes, reopening, clinical retention policy, production storage/scanning/backup erasure and release acceptance require clinic/operational work. Cloud DSC and AI remain deferred; native app work is paused. No PR or deployment was made. Next web increment: conversational WhatsApp inbox and remaining notification/template administration; the other open audit items remain open.

Validation: migration 46 applied to disposable databases; 91 affected API integration cases across six suites passed, including 13 rights cases covering closure retention, independent ZIP checks, erasure evidence, concurrency and India-calendar dates. All 52 scoped web/API/worker/shared checks passed; formatting/diff checks passed. All 74 web browser tests passed against the final build, including 390px/1280px rights flows. The dashboard range-change test now waits for the selected report before checking its metrics. These are synthetic local checks, not live Meta/Cashfree delivery, production infrastructure or clinic acceptance.

### WhatsApp service inbox and provider template catalog — 5 November 2026

Implemented ADR 0030 locally: immutable explicit clinic/sender/WABA routing, signed/deduplicated encrypted incoming text, unsupported-media placeholders, team and private doctor handoffs, read/resolve/reopen controls, explicit service-template agreement, STOP and clinic account-closure revocation. Replies use stable immutable intent IDs, keyed fingerprints, one-time authorization, service-window/permission/consent/template rechecks, bounded Meta calls, durable queued-intent recovery and uncertain-state handling without automatic resend. Signed status callbacks reconcile early and out-of-order results. English/Hindi web inbox and admin catalog support provider synchronization and explicit enable/disable of fresh approved static utility templates. Provider template creation/editing remains in the linked Meta Manager. No chart association or clinical authority is inferred from WhatsApp contact.

This closes the core conversational inbox and static service-template catalog slice locally. Dynamic/template notification bindings, full notification-event administration, provider-side authoring within this app, multiple simultaneous inbox numbers per clinic, costing, exceptional doctor-offboarding access, production transcript retention and live Meta acceptance remain open. Automated notification configuration remains separate. Native work stays paused, cloud DSC/AI stay deferred, credentials/mappings follow later; no PR, deployment or real external messages. Next web work can address bulk clinic session changes and operational notifications, with the remaining messaging administration backlog still visible.

Validation: all 47 migrations applied to fresh disposable databases; 72 affected API integration tests across five suites passed, including 15 inbox scenarios, account closure, tenant isolation and legacy WhatsApp/appointment regression. All 52 scoped web/API/worker/shared checks passed. The new 390px/1280px browser scenarios pass with an explicitly fake send/provider-availability fixture; they cover real authenticated inbox controls, template enablement, one-reply recovery and private doctor handoff. All 76 web browser tests passed on the final build. The clinic-day dashboard test now waits for the selected daily report before checking its tiles. After the final recovery-control adjustment, all 15 affected web/browser check tasks also passed; formatting and diff checks passed. Configuration tests reject reuse of the shared OTP/notification number as a clinic inbox sender. These checks do not activate or prove live Meta delivery, token scope/number registration/template approval, costing, retention or a production pilot.

### Reviewed bulk session operations and generic update notices — 5 November 2026

Implemented ADR 0031 locally: bounded frozen previews for one doctor/clinic/day interval, explicit confirmation/unchanged-exception acknowledgement, creator-bound atomic cancel/move/delay application, source/financial/clinical snapshot rechecks, checked target allocation, source availability closure and immutable stable-ID recovery receipts. Financial/prepaid/care-started bookings stay unchanged for individual review; there are no automatic refunds, bill transfers or doctor substitution. Explicit leave/holiday closures now also block new walk-ins. Delay estimates annotate today's waiting appointments in staff and patient views without moving booked times.

Optional additional generic WhatsApp update intents use appointment-category consent and a separate worker dispatcher. One-time authorization rechecks the applied source, current recipient/guardian/contact/consent, closure and expiry; callback-before-response preserves stronger status and unknown outcomes do not auto-repeat. The approved template receives only clinic name and portal-login URL. Default-off configuration and operator instructions are documented. Replacement booking confirmations/reminders remain independent; queued does not mean delivered.

This closes the reviewed core bulk-session/delay slice within its per-operation limits (200 source rows, 50 eligible changes, 15-minute preview). Multi-day campaigns, arbitrary per-patient auto-packing, bulk doctor substitution, financial/prepaid migration/refunds and broader notification-template/cost administration remain open/manual. Live Meta/Redis/provider/pilot acceptance and production infrastructure remain outstanding. Native work stays paused; cloud DSC/AI stay deferred. No PR, deployment or actual external message/payment was made. Next web priorities include assessments/review requests and the remaining confirmed specialty/import/online-consultation/ABDM and release requirements.

Validation: all 48 migrations applied to fresh disposable databases; 72 affected API integration tests across five suites passed, including 11 bulk-operation cases, individual appointments, prepaid booking, appointment notifications and tenant isolation. The operational receipt case was rechecked against the final build and preserves an early read callback. All 52 scoped web/API/worker/shared checks passed; formatting and diff checks passed. Both 390px/1280px browser scenarios pass for actual applied-response interruption/recovery, preserved bill, queued notice count and patient delay visibility. All 78 web browser tests passed on the final build. These are synthetic local checks, not live delivery or production acceptance.

## 2026-11-05 — Coolify client-preview hosting

At the owner's request, remaining feature development is paused in favour of hosting the existing web progress for a client demonstration. The local implementation now includes production Node container targets, a single-origin Coolify Compose stack, private persistent PostgreSQL/Redis/file storage, ordered migrations, service health checks, synthetic-only manual bootstrap with normal MFA, runtime preview notice, log limits, a paired backup script and hosting/demo instructions. Native CI builds are opt-in while native development is paused. See ADR 0032 and `docs/runbooks/coolify.md`.

This is preparation and local container verification, not an actual Coolify deployment or completion of the remaining real-patient launch gates. The hosting branch must contain the local web work; an older remote commit will not include it. Actual-host HTTPS, proxy CIDR, secrets, monitoring/backups and the client rehearsal still need to be configured on Coolify.
## Owner request — clinic people administration (6 November 2026)

- [x] Build a clinic user-management portal similar to Microsoft 365 admin: searchable
  doctor/staff directory and a detail page with Profile, Roles, Access and Security.
- [x] Let authorised clinic admins manage staff names, verified email/mobile changes,
  clinic-scoped roles and account access. Define how edits to shared user identities
  affect memberships in other clinics before implementation.
- [x] Add permission checks, audit history, session revocation when access changes,
  self-lockout/last-admin safeguards and tests for clinic isolation. Integrate existing
  invitations, authenticator recovery and session controls into this portal.

**Status: implemented and under release validation.** See the implementation update below
and the clinic People runbook for shared-identity limits and verification provider setup.
Existing deferred work and real-provider acceptance requirements remain open.

The owner also asked whether two-factor authentication can be disabled. Staff and platform
sign-in currently require an authenticator; there is no disable setting. No authentication
policy change has been requested or implemented by this backlog entry. Any future change
must explicitly define its scope (preview/live, staff/platform) and recovery behaviour.


### Owner update - configurable login second factors (6 November 2026)

The owner subsequently requested implementation of a disable option and OTP as a second
factor. Local implementation now exposes independent server-owner deployment settings
`STAFF_MFA_MODE` and `PLATFORM_MFA_MODE`: `totp` (unchanged default), `whatsapp`, or
`disabled` (password only). WhatsApp codes follow a validated password and use controlled
recipient mappings, hashed single-use challenges, expiry, send limits and account lockout.
Patient authentication and platform IP controls are unchanged. Browser login handles both
session completion and a second-factor challenge without exposing refresh tokens.

See [second-factor configuration](../runbooks/second-factor-auth.md) for deployment and
recipient requirements. This is not a per-user/clinic management UI; the People portal
above remains pending. Initial invitation/operator enrollment still uses the existing
trusted authenticator setup. No hosted policy or credentials were changed.


### Implementation update - clinic People portal (6 November 2026)

The previously pending clinic user-management increment is now implemented locally:
searchable/paginated People directory; per-person Profile, Roles, Access, Security and
Activity pages; exclusive staff display-name editing; clinic-scoped role assignment and
access disable/re-enable; self/last-admin safeguards; security/device/reset integration;
version checks and audit history. Email/mobile changes require admin password reauthentication,
a code delivered to the new destination, and confirmation by the signed-in staff owner
with their current password. Contact updates are atomic and end staff sessions. Shared
staff/patient identities require platform support, preserving cross-clinic ownership.

SMTP email verification is optional/configuration-gated; mobile verification uses the
existing WhatsApp sender. Initial account enrollment and deployment-level MFA policy
are unchanged. Provider credentials, live delivery acceptance and release verification
remain required. This supersedes the pending implementation status above for this scope;
it does not implement Microsoft 365 mailboxes, general platform-user editing, shared-account
identity migrations or per-user MFA preferences. See [People administration](../runbooks/clinic-people.md).

### Web development resumed — 7 November 2026

The owner resumed remaining web development after the client-preview deployment.
Numeric patient assessments and accountant reconciliation exports are now implemented
on the development branch; this entry does not claim a new hosted deployment.

- [x] Assessment form publishing/archiving with fixed definitions and EN/HI author text.
- [x] Doctor assignment and chart-authorised history; patient/guardian answering with
  current consents, encrypted responses, raw server scores and same-form score trends.
- [x] Retry/concurrency controls, immutable clinical response history, clinic RLS, audit
  events and inclusion in owned patient data exports.
- [x] Complete successful reconciliation snapshot exports for settlements and issues:
  clinic-admin access, exact INR paise, private downloads, export auditing, CSV escaping
  and formula protection, with a 5,000-row bound per file.

See ADR 0033 and the reconciliation-export runbook. This closes the core numeric-scale
assessment journey and CSV accountant-export gaps. Named/licensed clinical scoring packs,
branching/free-text assessments, notifications and automated assessment corrections are
not part of this increment. Bank-statement matching and automated financial discrepancy
resolution remain separate open work.

Remaining development includes EMR import/mapping/dry
runs, online-consultation identity/consent/join workflows, ABHA/ABDM M1/Scan & Share/M2,
remaining messaging administration and usage, confirmed specialty packs, production
storage/scanning, monitoring/hardening and broader public-site/platform features from
the maintained audit. Existing provider activation, clinical/pilot acceptance and actual
host backup/restore gaps remain open. Native apps and SMS stay paused; cloud DSC and AI
stay deferred until the owner resumes them. The complete web product is not finished.

### Optional review requests — 7 November 2026

Implemented locally (ADR 0034): clinic review settings, independent verified-number-holder
opt-in/withdrawal, completed-visit eligibility, shared-contact cooldowns, stable request
recovery and cancellation. A default-off durable WhatsApp worker rechecks authorization,
preserves signed delivery callbacks and does not resend uncertain outcomes. Purpose-bound
fragment links expose only the clinic; an explicit Continue action counts one opening.
Provider delivery states and openings do not claim a posted review. Tenant isolation,
audit, settings invalidation, STOP and owned data exports are included.

See the review-request runbook for the approved neutral Meta template, configuration and
real-recipient acceptance. No live provider activation or hosted deployment is claimed.
Next core development is EMR import with mapping, dry runs and validated application;
the other open/deferred work above remains open.
