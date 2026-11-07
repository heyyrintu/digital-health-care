# Data Dictionary

**Status:** Draft · **Owner:** Backend lead · **Update:** with every migration.

Conventions for every table: `id` (UUID), `organisationId` (except platform-level User/Device, PlatformOperator and PlatformSession), `createdAt`, `updatedAt`, `deletedAt` where soft delete applies; append-only evidence tables such as AccountConsent carry their own event times instead (`acceptedAt`, `withdrawnAt`). Files are stored by S3 key, never by public URL. Fields marked *(encrypted)* use field-level encryption. Row-level security filters every query by `organisationId` (ADR 0014). Database columns are snake_case (`organisation_id`); this document uses the camelCase field names.

**Implemented so far:** Organisation, User, Membership, StaffInvite, Session, OtpChallenge and AuditLog (Phase 0); Patient, UhidSettings, Tag and PatientTag (patient register); Clinic, ConsultationType, BookingRules, AvailabilityVersion and AvailabilityException (availability); Appointment and AppointmentStatusHistory (appointments); DisplayScreen (queue); PriceListItem, Bill, BillItem, Payment and ReceiptSettings (billing and counter payments); OrganisationSettings (clinic admin settings); OrganisationBranding (per-organisation branding); AccountConsent (patient onboarding consents); DoctorProfile (prescription pad and verification); PlatformOperator and PlatformSession (platform console); Referral (referrals, slice 1); ReferralLetter and ReferralLetterVerification (the signed referral letter, slice 2); TestCatalogueItem, TestOrder and TestResult (test orders); DocumentFile, LibraryDocument and PatientDocument (attachments and the clinic document library, part 1) — see `packages/db/prisma/schema.prisma`. Everything else below is the target design.

## Platform and identity

| Entity | Purpose | Key fields |
|---|---|---|
| Organisation | Practice or clinic group (tenant) | id, slug (unique, used in sign-in and clinic links), name, legalName, status; the chart model and other clinic admin settings are in OrganisationSettings, the public look in OrganisationBranding |
| OrganisationBranding | Per-organisation look on the public pages and the patient portal (built; table `organisation_branding`, one row per organisation, none until a clinic admin saves; row-level security). Its own table, not columns of OrganisationSettings, because these columns are published to anonymous visitors through definer functions and the settings are internal (ADR 0017 addendum 2) | organisationId (key), displayName (1–80 characters, no spaces at either end, no control, bidirectional or invisible characters: U+0001–U+001F, U+007F, U+061C, U+200B–U+200F, U+202A–U+202E, U+2060, U+2066–U+2069, U+FEFF), accentColour (`#rrggbb` lowercase; the API also needs 4.5:1 contrast with white text), tagline (1–120 characters, same rules as displayName), logoKey (file store key, `organisations/<organisationId>/branding/logo-<12 hex>.<png\|jpg\|webp>`: never another organisation's folder), logoMediaType (image/png\|image/jpeg\|image/webp; never SVG), logoSizeBytes (1–524288), logoSha256 (64 lowercase hex; the public logo address, indexed), updatedAt. The four logo fields are all set or all null. CHECK constraints in migration `20261019090000_organisation_branding`; read anonymously only through `public_organisation_branding(slug)` (slug, name, displayName, accentColour, tagline, logoSha256 of an active organisation), `public_organisation_logo(sha256)` (each active organisation's copy: file key, type and size, newest first, at most 8, for the API's logo route only) and `public_doctor_directory()` version 2 (adds organisation_display_name only). Audited as `organisation.branding_updated` (field names only) |
| Branding (planned rest) | Senders and domains, later | customDomain, whatsappSender, smsSenderId, emailDomain, googleReviewUrl |
| Clinic | Physical location (built: name unique per org, address, phone, timezone default Asia/Kolkata, active) | organisationId, name, address, geo, phone, gstin?, timezone, hfrId, active |
| User | Platform-level login identity (no organisationId) | phone (unique), email (unique), displayName, status, passwordHash (staff, scrypt), mfaSecret (staff, encrypted), mfaPendingSecret (encrypted, set during invite acceptance until the first code), mfaLastUsedStep (TOTP replay guard), failedLoginCount, lockedUntil, lastLoginAt |
| Membership | A user's role in one organisation; the auth link to tenants | organisationId, userId, role (patient\|doctor\|front_desk\|clinic_admin), status (invited\|active\|revoked) |
| StaffInvite | Single-use link to set up a staff account | organisationId, userId, role, purpose (join\|reset), tokenHash, createdByUserId, expiresAt (72 h), acceptedAt, revokedAt |
| Session | Refresh-token session on one device | userId, organisationId, role, refreshTokenHash, previousRefreshTokenHash (reuse detection), deviceId, userAgent, ip, expiresAt, lastUsedAt, revokedAt, revokedReason |
| OtpChallenge | Patient sign-in code | phone, organisationId, codeHash (HMAC), attempts, expiresAt, consumedAt |
| PushDevice | Phone or tablet receiving push notifications (built; table `push_devices`, sign-in role only like Session) | userId, organisationId, sessionId (the signed-in session it belongs to; must match its user and clinic), platform (ios\|android), appVariant (clinic\|patient), expoPushToken (unique: one row per app install; signing in again on the device moves it), deviceName, lastSeenAt, revokedAt, revokedReason (removed, logout, refresh_token_reuse, access_removed, authenticator_reset, support_authenticator_reset). Planned: biometricKeyId |
| PlatformOperator | Platform console account (built; table `platform_operators`, `dhc_platform` role only, ADR 0016). Not a User: no memberships, no clinical access; created and disabled only by the support command | email (unique, lower case), displayName, status (active\|disabled), passwordHash (scrypt), mfaSecret (encrypted, enrolled at creation), mfaLastUsedStep, failedLoginCount, lockedUntil, lastLoginAt |
| PlatformSession | Platform console sign-in (built; table `platform_sessions`, `dhc_platform` role only) | operatorId, refreshTokenHash, previousRefreshTokenHash (reuse detection), userAgent, ip, expiresAt (8 h), lastUsedAt, revokedAt, revokedReason |
| StaffMember | Staff profile in an organisation (role lives on Membership) | userId, organisationId, assignedDoctorIds |
| DoctorProfile | A doctor's prescription pad and signing details, per organisation (built) | organisationId, userId (unique together), registrationNumber, council, qualifications, specialty, rxPrefix (1–8 capitals or digits, unique per organisation), rxSequence (last number given), paperSize (a4\|a5), verification (pending\|verified; changing the registration number or council resets it), verifiedAt, verifiedBy (operator and ticket), submittedAt (when it entered the platform verification queue: first save, or a new registration number or council), signingPinHash (scrypt of a server-keyed digest of the PIN), pinFailedCount, pinLockedUntil; the public page (ADR 0017): publicSlug (`/doctor/<publicSlug>`; lowercase letters, digits and single hyphens, 3–60, unique across all organisations), listed (default false; needs a publicSlug; shown only once verified), about (1–1000 characters), languages (up to 8 names, 1–40 characters each, each once whatever the case), publicUpdatedAt (last change to those fields, for the sitemap; `updatedAt` also moves with PIN attempts so is never published). CHECK constraints in migration `20261018150000_public_doctor_pages`; read anonymously only through `public_doctor_profile(slug)`, `public_doctor_slugs()` and `public_doctor_directory()` (the home page's cards: slug, name, qualifications, specialty, organisation name, scheduled clinics' names and first address line, languages and lowest fee; at most 500 by name; migration `20261018180000_public_doctor_directory`) · planned: hprId, signingProviderRef |
| DoctorClinic | Doctor practises at clinic | doctorId, clinicId, active, consultationTypeIds |
| DoctorOnboarding | Onboarding state | doctorId, status (invited\|pending_verification\|verified\|active\|suspended), registrationDocKey, verifiedBy, verifiedAt, checklist (JSON) |

## Patients

| Entity | Purpose | Key fields |
|---|---|---|
| Patient | Person receiving care | organisationId, accountUserId, uhid (unique per org), name, phone (E.164; family members may share one), dob, gender (female\|male\|other), email, address, bloodGroup, language (en\|hi), emergencyContactName, emergencyContactPhone, guardianPatientId (one level: a guardian has no guardian), createdByUserId, mergedIntoId and mergedAt (set when merged into another record, which is then the one in use; merged records are read-only and nothing new may point at them) |
| PatientMergeRequest | A request to merge a duplicate patient record into the one that stays (built; row-level security per organisation) | organisationId, sourcePatientId (the duplicate), targetPatientId (kept), reason, status (pending\|approved\|rejected), requestedByUserId, requestedAt, decidedByUserId, decidedAt, decisionNote (required when rejected). One pending request per source; requests are decided, never deleted |
| UhidSettings | Per-organisation UHID numbering | organisationId (key), prefix (up to 8 letters or digits), nextNumber (default 10001); UHID = prefix + number, e.g. EK10001 |
| OrganisationSettings | Clinic admin settings (PRD §9.2), one row per organisation; defaults until saved | organisationId (key), chartModel (shared\|own_patients, default shared), hiddenSafetyRules (only SR-06, SR-08, SR-15), maxUploadMb (1–25, default 10), uploadTypes (pdf, jpeg, png, heic; at least one; default pdf, jpeg, png) |
| Tag / PatientTag | Configurable labels | Tag: organisationId, name (unique per org), colour (#rrggbb), sortToTop, archivedAt (archived, never deleted) · PatientTag: organisationId, patientId, tagId, addedByUserId, createdAt |
| Allergy | Recorded allergy (built) | patientId, substance, reaction, source (doctor\|patient; patient = unverified), recordedByUserId, createdAt, removedAt, removedByUserId, removedReason (removed, never deleted) · planned: class/molecule link for the safety engine, severity |
| MedicalCondition | Known condition (built) | patientId, name, icd10Code?, source, recordedByUserId, createdAt, removedAt, removedByUserId, removedReason · planned: since |
| CurrentMedication | Ongoing medicine from elsewhere (built) | patientId, name, dose?, source, recordedByUserId, createdAt, removedAt, removedByUserId, removedReason · planned: moleculeId, since |
| AccountConsent | A patient account's acceptance of the privacy notice, terms or health-data consent at onboarding (built); one row per acceptance, never deleted | organisationId, userId (the account), kind (privacy_notice\|terms\|health_data), version, acceptedAt, withdrawnAt (only health data is withdrawn on its own; only this column may change) |
| Consent | Per-patient consent for a purpose (telemedicine, guardian, scribe, ABDM); onboarding consents are AccountConsent | patientId, type (data_processing\|telemedicine\|guardian\|scribe\|abdm), version, givenBy, givenAt, withdrawnAt, context (consultationId?) |
| MessagingOptIn | Channel opt-in | patientId, channel (whatsapp\|sms\|email\|push), status, source, at |
| AbhaLink | ABHA linked to patient | patientId, abhaNumber (encrypted), abhaAddress, linkedVia, verifiedAt, status |

## Scheduling

| Entity | Purpose | Key fields |
|---|---|---|
| ConsultationType | Mode and pricing | organisationId, name (unique per org), mode (in_person\|audio\|video), defaultDurationMin (5–240), feePaise, followUpFeePaise?, requiresPrepayment, active |
| BookingRules | Booking window and limits (built; more rules to come) | organisationId (key), horizonDays (default 30, 1–365), sameDayCutoffMinutes (default 60, 0–1440), overbookPerDay (default 2, 0–50; per doctor per day), noShowAfterMinutes (default 30, 0–720 or empty for off; minutes after a slot ends before an unattended booking becomes a no-show) |
| AvailabilityVersion | Weekly schedule version; never edited, a new one takes over from its date | organisationId, doctorUserId, clinicId, consultationTypeId, effectiveFrom (date, unique with doctor + clinic + type), weekly (JSON: `{mon: [{start, end}]}`, IST `HH:MM`; gaps between sessions are breaks), slotMinutes (5–240), bufferMinutes (0–120), createdByUserId |
| AvailabilityException | Leave (a doctor), holiday (a clinic, or every clinic when clinicId is empty), extra session (doctor + clinic + type) | organisationId, type (leave\|holiday\|extra_session), doctorUserId?, clinicId?, consultationTypeId?, startDate, endDate, startTime?, endTime? (both or neither; none = whole day), reason?, createdByUserId |
| Appointment | Booking or walk-in (built; never deleted) | organisationId, patientId, doctorUserId, clinicId, consultationTypeId, date (IST day of the queue), startAt, endAt, status (pending\|confirmed\|checked_in\|in_consultation\|completed\|cancelled\|no_show\|rescheduled), source (front_desk\|walk_in\|app\|web; scan_share planned), tokenNumber (per doctor + clinic + day, unique), overbook, reason, cancelReason, rescheduledFromId (unique: the booking this one replaced), checkedInAt, consultationStartedAt, completedAt (visit timing), createdByUserId; planned: joinInfo, holdExpiresAt |
| AppointmentStatusHistory | Status timeline (built; append-only) | organisationId, appointmentId, fromStatus (empty when created), toStatus, actorUserId (empty for automatic no-shows), at, note (cancel reason; why an automatic no-show was marked) |
| DisplayScreen | Waiting-room screen link (built; revoked, never deleted) | organisationId, clinicId, label, tokenHash (SHA-256 of the link token, unique), createdByUserId, createdAt, revokedAt |
| VisitTiming | Consultation duration (held on Appointment for now: checkedInAt, consultationStartedAt, completedAt) | appointmentId, startedAt, endedAt |

## Clinical

| Entity | Purpose | Key fields |
|---|---|---|
| Consultation | Visit record (built) | appointmentId (one per visit), patientId, doctorUserId, notesCipher (AES-256-GCM JSON: chiefComplaint, symptoms[{text, duration}], examination, diagnoses[{code?, label}], plan, privateNotes, testsAdvised, advice), followUpDate, revision (autosave guard), lockedAt (set when the prescription is signed) · planned: specialty examination templates |
| Vitals | Measurements, one set per visit (built) | appointmentId, patientId, bpSystolic, bpDiastolic, pulse, temperatureC, spo2, weightKg, heightCm, painScore (0–10), pregnancyStatus (not_pregnant\|pregnant\|breastfeeding), recordedByUserId, updatedAt; BMI computed; ranges checked in the database |
| ScribeSession | AI scribe run | consultationId, mode (ambient\|dictation), consentId, language, audioKey, audioDeletedAt, transcript (encrypted), draft (JSON), acceptedSections, modelVersion, promptVersion, status |
| AssessmentForm / Assessment | Questionnaires | Form: organisationId, name, questions (JSON), scoring · Assessment: formId, patientId, answers, score, completedAt, source |
| AskAiQuery | Ask AI log | patientId, doctorId, question, answer, citations (JSON), modelVersion, at |

## Prescribing

| Entity | Purpose | Key fields |
|---|---|---|
| DrugMolecule | Reference drug data (built; platform-wide, read-only to clinics; the licensed database in production, a synthetic sample in development) | name, drugClass, pregnancy (caution\|contraindicated), lactation (caution\|contraindicated), pregnancyOverridable, weightBased, childMinMgPerKgDay, childMaxMgPerKgDay, childDoseOverridable, maxDailyMg (from 12 years), maxDoseOverridable, olderAdultCaution, renalAdjustment, hepaticCaution, telemedicineList (o\|a\|b\|prohibited) |
| DrugInteraction | Interacting pair (built) | moleculeAId < moleculeBId, severity (contraindicated\|major\|moderate\|minor), overridable, note |
| DrugCrossSensitivity | Allergy class that warns for another class (built) | allergyClass, drugClass, note |
| DrugConditionRule | Molecule or class to take care with in a condition (built) | moleculeId or drugClass, conditionCodes (ICD-10 prefixes), conditionTerms, note |
| DrugDatabase | The loaded reference data (built, one row) | version, loadedAt |
| MedicineIngredient | A molecule in a medicine (built; follows the medicine's visibility) | medicineId, moleculeId, strengthMg and per (unit\|ml), null when unknown |
| Medicine | Medicine in the master (built) | organisationId (null = platform reference master; clinics read it but cannot change it), name, genericName, composition, form, ingredients (MedicineIngredient), defaultRoute, source (reference\|clinic), active (inactive medicines are hidden and cannot be prescribed) · planned: scheduleTag. Clinics add, edit and deactivate their own (§3k of the API guide); brand names typed by doctors map to a medicine through MedicineRequest, updatedAt (moves on every change; the Clinic app's offline cache fetches what changed since its cursor) |
| MedicineRequest | The clinic admin's decision on a medicine name doctors typed (built; row-level security per organisation) | organisationId, nameKey (lower case, single spaces; unique per organisation), name (as typed), decision (approved\|rejected), medicineId (set exactly when approved: a reference medicine or this clinic's), reason (required when rejected), decidedByUserId, decidedAt. The queue itself is not stored: it is worked out from PrescriptionItem rows with no medicineId. Deleting the row (undo) returns the name to the queue |
| PrescriptionTemplate | Saved prescription (built) | organisationId, doctorUserId, name (unique per doctor within the organisation), items (JSON lines without IDs) · planned: advice, tests |
| Prescription | Prescription document, one row per version (built; immutable once signed, enforced by database triggers) | appointmentId, patientId, doctorUserId, version (1, then one more per amendment), status (draft\|signed\|superseded\|void), language, revision, amendsPrescriptionId + amendmentReason (amendments), number (doctor's prefix + running number, kept by amendments), signedAt, pdfFileKey + pdfSha256 (the signed file by storage key, and its hash), templateVersion, paperSize, signatureMethod (test_key\|cloud_dsc), signature (over the PDF's SHA-256), signerCertificate, verificationCode (printed in the QR), supersededAt, voidedAt, voidedByUserId, voidReason, voidPdfFileKey (the copy stamped VOID; the signed file is kept) |
| PrescriptionVerification | Public QR lookup (built; readable without a session, holds no clinical data) | codeHash (SHA-256 of the code), organisationId, prescriptionId |
| PrescriptionItem | Medicine line (built) | id (client-chosen UUID), prescriptionId, medicineId?, name, composition, form (snapshots), route, timing, steps (JSON: dose, frequency, durationValue, durationUnit; several for tapering), quantity, instructions, remarks (generated unless remarksEdited), sortOrder |
| PrescriptionTest | Test on prescription | Not a table: TestOrder.prescriptionId names the version that ordered each test, and the PDF of every version prints the visit's tests |
| SafetyAlert | The safety log: an alert and the doctor's answer (built; never deleted) | prescriptionId, key (rule, line, subject; unique per prescription), ruleId, itemId?, severity (block\|warn\|info), overridable, message, params, firstShownAt, lastShownAt, resolvedAt? (set while the alert no longer fires), action? (acknowledged\|overridden\|changed; null while unanswered), reason?, actionByUserId?, actionAt?, drugDatabaseVersion |

## Orders and documents

| Entity | Purpose | Key fields |
|---|---|---|
| TestCatalogueItem | A test doctors can order (built; per organisation, row-level security; seeded with 18 blood tests, X-ray, MRI, CT and 5 others for every organisation by a trigger on `organisations`, and for existing ones by the migration) | organisationId, kind (blood\|xray\|mri\|ct\|other), name, regions (imaging only), views (X-ray only), active (deactivated, never deleted: orders point at items), sortOrder. Clinic admins edit it. **The database enforces:** the shape (regions only on imaging, views only on X-rays), names 1–120 characters with no whitespace of any kind at either end, unique per organisation among active items in any case (partial unique index on `(organisation_id, lower(name)) WHERE active`), at most 40 regions, each 1–80 characters with no whitespace at either end and once in any case, views only from AP, PA, Lateral, Oblique, Skyline, Standing and each once, and sortOrder ≥ 0. **Only the API enforces:** at most 300 items per organisation, active or not, and the kind never changing after creation (the API also tidies inner whitespace in names and regions). Index on `(organisation_id, sort_order)` for the admin's list |
| TestOrder | A test ordered at a visit (built; row-level security; PRD §7.1) | id (client-chosen UUID), appointmentId, patientId and doctorUserId (the visit's, enforced by trigger), catalogueItemId? (null for free text), kind, name (snapshot), region, side (left\|right\|both\|na; imaging only), views (X-ray only, up to 6), notes (for the lab; printed), sortOrder, status (ordered\|result_uploaded\|reviewed), prescriptionId and orderedAt (null while a draft line; set together when a prescription version is signed), resultUploadedAt, reviewedAt + reviewedByUserId (together). Draft lines are written with the prescription draft. Triggers: a row cannot be inserted already ordered; it becomes ordered only by the visit's newest version, signed, with orderedAt equal to its signedAt; once ordered it cannot be deleted or changed except for the status, its times and the reviewer, and the status only moves forward (the upload time is never cleared, a reviewed test never changes, and `reviewed` needs `result_uploaded` with a stored result first); the reviewer must be a doctor of the organisation |
| TestResult | A result uploaded for an ordered test (built; row-level security; append-only for the app) | testOrderId (an ordered test of the same organisation, enforced by trigger), fileKey (storage key, `organisations/<org>/test-results/<order>-<random>.<ext>`; no patient data), mediaType (as sent and checked against the file's first bytes), sizeBytes, sha256 (checked on every read), uploadedByUserId, uploadedByRole (patient\|front_desk\|doctor; the uploader must hold that membership in the organisation, enforced by trigger; a check allows only these three roles; another check allows only the five upload media types), uploadedAt; at most 10 per order (the API counts under the order's lock) · planned with the files module: scanStatus (malware scan before visibility), MedicalDocument link |
| Referral | A referral made at a visit (built, slice 1; table `referrals`, row-level security; PRD §7.2) | appointmentId (the visit), patientId and referringDoctorUserId (the visit's patient and doctor, enforced by trigger, which also locks the visit FOR SHARE), kind (internal\|external), receivingDoctorUserId (internal only: a doctor of the organisation, not the referring one; both doctors must hold a doctor membership of the organisation, active when the referral is made), externalName (external only, required, 1–120), externalSpecialty (≤ 80), externalHospital (≤ 160; these three on one line, no whitespace at either end, no control characters), externalPhone (6–20 digits, spaces, brackets, hyphens, optional leading +), reason (1–500, several lines allowed), urgency (routine\|soon\|urgent), notes (≤ 2000), status (sent\|seen\|closed), sentAt, seenAt (internal only; set with `seen`), closedAt + closedByUserId (together; set with `closed`; the closer is the referring or the receiving doctor), closeNote (≤ 500, only when closed). Plain text, like test order notes (not field-encrypted). **The database enforces:** the internal/external shape, the lengths, that each status carries its own times in order (seen after sent, closed after both); `same_tenant_reference` on patientId and appointmentId; no new referral for a merged record; inserted only as `sent`, after which only the status, its times, closer and note change, forwards only (sent → seen → closed, or sent → closed), a closed referral not at all, and no referral is deleted (`dhc_app` has no DELETE); a patient or visit with referrals keeps its organisation, and the visit its patient and doctor. Status history is these timestamps (the steps are fixed and few), not a separate table. The signed letter is a ReferralLetter (below). Not built: attachments |
| ReferralLetter | The signed referral letter PDF (built, slice 2; table `referral_letters`, row-level security; PRD §7.2; ADR 0008) | referralId (unique: one letter per referral), signedByUserId (the referral's referring doctor), language (en\|hi; the patient's unless the doctor chose the other), paperSize (a4\|a5, from the pad), templateVersion (`referral-<n>`; `referral-1` first), pdfFileKey (the PDF in the file store, `organisations/<org>/referrals/<referralId>-letter-<random>.pdf`), pdfSha256 (64 lowercase hex), signatureMethod (test_key\|cloud_dsc), signature (of the PDF's SHA-256, base64), signerCertificate, verificationCode (unique; 24 characters of Crockford base32, in the QR as `/verify/referral/<code>`), signedAt. **The database enforces:** the formats above (CHECK `referral_letters_fields_check`); that the referral is of the same organisation, signed by its referring doctor and not closed when the letter is inserted (trigger, which locks the referral FOR SHARE); and that a letter never changes and is never deleted, by any role (trigger; `dhc_app` has SELECT and INSERT only). Closing the referral afterwards leaves the letter as it is. Nothing clinical is copied here: the letter's text lives only in the PDF |
| ReferralLetterVerification | Public QR lookup for referral letters (built; readable without a session by the sign-in role, holds no clinical data), like PrescriptionVerification | codeHash (SHA-256 of the code, base64url), organisationId, referralLetterId (unique); the letter must be of the same organisation (trigger); never changed or deleted (trigger) |
| DocumentFile | One stored document file (built, attachments part 1; table `document_files`, row-level security; PRD §7.3) | fileKey (unique storage key, `organisations/<org>/documents/<12 hex>.<pdf\|jpg\|png\|webp>`; a CHECK keeps it in the organisation's own folder with the extension of its type; no patient data, title or file name), mediaType (`application/pdf`, `image/jpeg`, `image/png` or `image/webp` only; never SVG, HTML or HEIC), sizeBytes (of the stored file: an image as uploaded, within the clinic's `maxUploadMb`; a PDF as rebuilt from its pages on upload, threat model T27), sha256 (of the stored file, checked on every read), uploadedByUserId and uploadedByRole (doctor\|clinic_admin; an active member of the organisation in that role, trigger), uploadedAt, attachedAt (set once, when the fresh upload is first used for a library sheet or a share; a fresh upload is used once, by its uploader, within 24 hours). Never changed (only `attachedAt`, once) or deleted (trigger). A file is a version: giving a sheet a new file adds a row and the old one stays for the shares made with it. Unused uploads are not cleaned up yet (open item) |
| LibraryDocument | A reusable sheet in the clinic library (built, part 1; table `library_documents`, row-level security; PRD §7.3: "clinic library of reusable sheets") | title (1–120, one line, no control, bidirectional or invisible characters; CHECK), category? (exercise\|diet\|information\|other), language (en\|hi\|other), fileId (the current version, a DocumentFile of the same organisation, trigger), createdByUserId (an active doctor or clinic admin of the organisation, trigger), archivedAt and archivedByUserId (together; archived sheets are hidden from sharing, kept, and can be restored), createdAt, updatedAt. Only the title, category, language, file and archiving change; never deleted (trigger). At most 500 per organisation (`MAX_LIBRARY_DOCUMENTS`), active or archived |
| PatientDocument | A document shared with a patient (built, part 1; table `patient_documents`, row-level security; PRD §7.3; the PRD's **Attachment**). Part of the clinical record | patientId (not a merged record, trigger; a merged duplicate's documents show under the kept record), appointmentId? (the visit it was shared at: the patient's own, checked in or later or with notes, never a booking still to come, trigger), source (library\|upload; a library share names its sheet, an upload none: CHECK), libraryDocumentId? (an active sheet whose current file is `fileId` when shared, trigger), fileId (the exact DocumentFile shared), title, category?, language? (copied from the sheet when shared, so renaming, replacing or archiving the sheet never changes the patient's copy), note? (to the patient, up to 500 characters over several lines), sharedByUserId (an active doctor of the organisation, trigger), sharedAt, openedAt? (first opening by anyone on the patient's account; set once), withdrawnAt and withdrawnByUserId (together, set once, by an active doctor: the patient stops seeing it; the row stays). Nothing else ever changes; never deleted (trigger). A patient or visit with documents keeps its organisation (and the visit its patient). Sending it on WhatsApp, SMS or email (`sentVia`) is not built yet |
| MedicalDocument | Uploaded record | patientId, uploadedByUserId, category, reportDate, mimeType, sizeBytes, storageKey, sha256, scanStatus, appointmentId?, orderId?, reviewedByDoctorAt, referencedInConsultation, historicalImport |

## Billing and payments

| Entity | Purpose | Key fields |
|---|---|---|
| PriceListItem | Chargeable item (built) | organisationId, name (unique per organisation), pricePaise (> 0), active (deactivated, never deleted) · planned: category |
| Bill / BillItem | Charges for a visit (built) | Bill: appointmentId (one bill per visit), patientId and doctorUserId (the visit's, enforced by trigger), subtotalPaise, discountPaise, discountReason (required with a discount), totalPaise (= subtotal − discount), paidPaise, status (due\|partly_paid\|paid; follows paidPaise, checked by the database), revision, createdByUserId · BillItem: billId, kind (consultation\|follow_up\|item), priceListItemId (items only), name and unitPaise (snapshots at billing), quantity (1–99), amountPaise (= unit × quantity), sortOrder; fixed once the bill has a payment · planned statuses: link_sent, refund_pending, refunded |
| PaymentGatewayAccount | Cashfree account per organisation | organisationId, provider (cashfree), mode (sandbox\|production), keyRef (secret store, encrypted), kycStatus, methodsEnabled |
| Payment | Payment (built for the counter: id chosen by the client so retries record once, billId, mode cash\|upi\|card, amountPaise, reference, receiptNumber unique per organisation, receivedByUserId, receivedAt; append-only) · planned for Cashfree | billId, method (cash\|upi\|card\|netbanking\|wallet\|counter_upi\|counter_card), channel (link\|in_app\|web\|counter), gateway, gatewayOrderId, gatewayPaymentId, paymentLinkId, amount, gatewayFee, status, paidAt, settledAt |
| PaymentLink | Cashfree link | billId, gatewayLinkId, expiresAt, status, sentVia |
| Refund | Refund | paymentId, amount, reason, gatewayRefundId, status, requestedBy |
| Settlement | Cashfree settlement | organisationId, gatewaySettlementId, date, gross, fees, net, matchedAt |
| Receipt | Numbered receipt | Built as Payment.receiptNumber, numbered by ReceiptSettings (organisationId, prefix default `R`, nextNumber; advanced under a row lock) · planned: pdfKey, issuedAt |

## Messaging

| Entity | Purpose | Key fields |
|---|---|---|
| MessageTemplate | Template per channel | organisationId, key, channel, language, body, category (utility\|authentication\|marketing), dltTemplateId?, approvalStatus |
| Notification | Outgoing message | organisationId, patientId?, userId?, templateKey, channel, status, cost, providerMessageId, sentAt, readAt |
| DeliveryLog | Delivery events | notificationId, status, at, retry, fallbackTriggered |
| MessageThread | Inbound conversations | organisationId, patientId, channel, lastInboundAt, assignedTo |
| WebhookEvent | Inbound webhook store | provider, eventId, organisationId, signatureValid, receivedAt, processedAt, result |

## ABDM

| Entity | Purpose | Key fields |
|---|---|---|
| CareContext | Linked record | patientId, abhaLinkId, consultationId, referenceNumber, linkedAt |
| HealthConsent | Consent artefact | patientId, requesterType (HIP\|HIU), purpose, hiTypes, dateRange, expiresAt, status, artefactId |
| ExternalRecord | Fetched record | patientId, consentId, sourceFacility, fhirBundleKey, fetchedAt |

## Governance

| Entity | Purpose | Key fields |
|---|---|---|
| AuditLog | Append-only audit (trigger blocks update/delete) | organisationId (null for platform events), actorUserId, action, entityType, entityId, requestId, ip, userAgent, at, metadata (IDs and reasons only, no patient data) |
| DataRightsRequest | DPDP request | userId, type (access\|correction\|erasure), status, handledBy, closedAt |
| ImportJob | Migration import | organisationId, files, mapping, dryRunReport, status, startedBy, completedAt |

## Retention classes

| Class | Entities | Rule |
|---|---|---|
| Clinical | Consultation, Vitals, Prescription(+Item, Alert), TestOrder/Result, Referral, PatientDocument with its DocumentFile, ScribeSession transcript | At least 3 years (legal minimum; confirm with lawyer); never patient-deletable |
| Audio | ScribeSession.audioKey | Deleted after retention window (default 7 days) |
| Financial | Bill, Payment, Refund, Settlement, Receipt | As required for financial records (confirm with CA) |
| Patient uploads | MedicalDocument (non-referenced) | Patient-deletable |
| Logs | AuditLog | Append-only; retained per security policy |


## WhatsApp OTP delivery metadata (implemented)

Migration `20261104130000_whatsapp_delivery`:

| Entity | Purpose | Stored fields |
|---|---|---|
| WhatsAppDelivery (`whatsapp_deliveries`) | One outbound OTP attempt, linked to its original organisation and challenge | id, organisationId, otpChallengeId (unique), senderPhoneNumberId, providerMessageId (unique within sender), status, lastStatusAt, numeric errorCode, createdAt |
| WhatsAppStatusEvent (`whatsapp_status_events`) | Durable verified receipt inbox and queue bridge | id, deliveryId, status, occurredAt, numeric errorCode, receivedAt, lastEnqueuedAt, processedAt; unique (deliveryId, status, occurredAt) |

No OTP, recipient number, raw callback, inbound chat or provider error text is stored in these tables. The challenge link is internal and is not exposed by the delivery-log API. `dhc_app` has tenant-scoped SELECT only on deliveries; it has no inbox grants. `dhc_auth` can call only the delivery create/accept/fail functions; `dhc_messaging` can call only receive/claim/process functions and cannot read any table directly. The worker writes `messaging.status_updated` audit events by internal delivery ID and status. No automatic purge job is included in this increment.


## Appointment messaging (implemented)

Migration `20261104150000_whatsapp_appointments`:

| Entity | Purpose | Key fields |
|---|---|---|
| WhatsAppOptIn (`whatsapp_opt_ins`) | Explicit appointment-message agreement for a number, practice and sender | id, organisationId, normalized phone, senderPhoneNumberId, enabled, monotonic version, changedAt, changedByUserId; unique (organisation, phone, sender) |
| WhatsAppOptOutEvent (`whatsapp_opt_out_events`) | Replay protection for verified STOP messages | SHA-256 event ID and receivedAt only; no phone or text |
| WhatsAppDelivery (extended) | Shared OTP/appointment outbox and receipt metadata | kind, nullable OTP source or appointment/patient/opt-in snapshot, optInVersion, appointmentStartAt, dueAt, expiresAt, dispatchLeaseAt, attemptedAt, static skipReason; unique appointment/kind/start/sender |

Only the consent table stores a contact phone, under organisation RLS. Worker functions release that contact for a valid due notice once; Redis jobs and public delivery logs still contain no recipient or clinical details. Source CHECKs distinguish OTP and appointment records. Consent revisions invalidate queued old notices. Queued, sending, skipped and uncertain supplement receipt states. No automatic retention purge is introduced. All application database connections explicitly serialize timestamps in UTC; calendar displays remain IST.

WhatsApp consent now has immutable `category` (`appointments` or `records`), unique with organisation/phone/sender. Record deliveries carry exactly one of prescription/referral-letter/patient-document IDs and an optional link expiry set at send authorization. The delivery-kind check enforces valid source combinations. Unique source/sender indexes prevent duplicate notices for each record; amendment versions are separate sources. Payload text, record titles and patient names are not copied into delivery rows.

`cashfree_orders` stores organisation/bill binding, immutable merchant/environment/amount/currency identity, encrypted original request details and checkout session, provider IDs, expiry and state. A partial unique index allows one creating/active/closing/review order per bill. `cashfree_events` stores only event hash/type/outcome and payment ID/amount/currency for investigation, never raw provider/customer/instrument details. `payments.cashfree_order_id` is unique and requires mode Cashfree; only the internal payment role may create its verified receipt. Both new tables have tenant RLS; application users may read but cannot write them. `dhc_payments` inherits tenant-scoped application permissions for internal verified reconciliation. `auth_cashfree_order` exposes only the ID/organisation mapping to the auth role, never the checkout session or financial details.

Refund implementation (ADR 0022): `cashfree_refunds` records immutable organisation/order/payment/bill binding, amount, currency, reason code, origin, requester and merchant refund ID. Provider refund identity is pinned once known. App requests have `rf` + UUID-without-hyphens IDs and one unresolved request per payment; provider-origin history can contain independent external requests. States are creating, pending, succeeded, cancelled, rejected and review. `refund_entries` is append-only, unique per refund and per RF voucher number, with original payment/bill, amount and ledger posting time. Its per-payment total cannot exceed the original receipt, and a succeeded request cannot commit without an entry. `refund_settings` numbers vouchers per organisation. `cashfree_refund_events` retains a raw-payload hash, refund IDs and processing outcome only. All new tables use tenant RLS; only the internal payment role writes. `cashfree_orders.refund_review_required` blocks new requests after a source/identity/amount discrepancy. Gross `Bill.paidPaise`, original payment rows and original receipt snapshots never decrease; refunded/net totals are derived from confirmed ledger entries.

### Cashfree reconciliation snapshots (ADR 0023)

`cashfree_recon_runs` captures tenant, original merchant/environment, completed IST period, requester or nightly key, queued/running/succeeded/failed state, bounded attempts, dispatch/processing leases and sanitized error/counts. A partial unique index prevents multiple queued/running runs for one account/period. `cashfree_recon_events` stores normalized PG/settlement identifiers, kinds/statuses and signed paise only; `cashfree_recon_settlements` stores UTR and gross/fees/tax/adjustment/net bigint columns. `cashfree_recon_issues` stores discrepancy codes, optional validated local source IDs and expected/reported paise; only review time/user/reason may change after publication. All four tables have tenant RLS. Ordinary application transactions read only; internal payment transactions insert reports and acknowledge review. Completed runs/results are immutable. No raw report/customer/bank/note payload is stored, and no reconciliation write changes a financial ledger.

### Prepaid booking reservations (ADR 0024)

`cashfree_bookings` binds the tenant, appointment, original order (same UUID as the request), creator, keyed request digest, frozen expiry and captured automatic-confirmation policy. State is held/confirmed/released/review; confirmed denotes verified payment, while the appointment may still await clinic approval. `next_check_at` is the durable check/expiry lease. Source IDs, request digest, policy and expiry are immutable. Only the internal payment role writes; tenant application reads use RLS. Appointment/bill-line/counter-payment guards prevent unpaid confirmation, moving a prepaid appointment, editing its quote or collecting through a replacement counter payment. Released/late-paid records remain for financial history and refund review.

### Financial availability notices (ADR 0025)

Migration `20261105030000_portal_finance_notices` adds `payments` opt-ins and optional `whatsapp_deliveries.financial_order_id`, `receipt_payment_id`, `refund_entry_id` references. The last references the refund ledger's `refund_id` primary key. Three source/sender unique indexes prevent duplicate notifications. Kind/source checks and a source/tenant/recipient guard protect immutable financial bindings. Existing outbox leases, attempted/link-expiry fields and delivery states are reused. Inserts of receipts/refund entries and first activation of an order enqueue within their source transaction. Neither outbox processing nor portal read/print changes the financial ledger.

### Patient profile increment (ADR 0027)

`patients.photo_key/photo_media_type` point only to an authenticated private image; neither key is exposed by portal DTOs. `reported_blood_group`, `blood_group_reported_at` and `blood_group_confirmed_at` distinguish an unverified patient report from the existing clinic-recorded blood group. Patient allergy/condition/current-medication reports reuse existing `source=patient` rows. Doctor confirmation retires the original with provenance and creates a doctor row.

`otp_challenges.purpose` is `sign_in` (default for existing clients) or `phone_change`; sign-in rejects the latter. `patient_phone_changes` is an auth-only RLS identity table with request/actor/clinic/patient IDs, normalized old/new numbers, nullable unique purpose-bound challenge IDs while preparing, expiry and completion time. No clinical content, plaintext OTP or refresh/access tokens are stored. Tenant/platform roles have no table grant. Patient/organisation/user foreign keys preserve integrity; resets use cascading truncation only in disposable test databases.

### Patient-origin records (ADR 0028)

`patient_records` holds tenant/patient/uploader IDs, encrypted title/note, category/date, optional same-patient appointment/order references, immutable input identity/file fingerprints, revision and awaiting/ready/deleting/deleted lifecycle. Private file keys never leave the API. Review attribution is separate from first care use. Hidden used rows retain clinical bytes; deleted unused tombstones clear bytes, encrypted details/fingerprints and clinical references.

`patient_record_shares` binds one random hashed/encrypted token to a record, named doctor, immutable grantor, creation/expiry and one-way revocation. It grants file-only access; grantor consent is rechecked. `patient_record_uses` binds a record/revision to the treating doctor/visit and is append-only. Its insert trigger stamps immutable first use on the record. All three tables enforce tenant RLS; auth/platform roles receive no clinical table grants. Purge claims/leases/next-attempt dates on the record make erasure recoverable without Redis.

## Patient data rights and closure (migration 46; ADR 0029)

- `patient_account_access`: clinic/user key, nullable irreversible closure instant. Auth can create/read open rows; tenant role can close its own clinic rows. Shared/exclusive row locks coordinate portal work and closure.
- `patients.portal_closed_at`: closes patient self-service matching; leaves in-person clinical history intact.
- `data_rights_requests`: tenant/user/optional subject, kind/area/state, encrypted immutable initial details, encrypted latest reply, assigned doctor, revision, retention policy/review metadata and evidence reference. Terminal decisions immutable.
- `data_rights_events`: tenant-bound append-only request events, actor/action/time; no free text.
- `account_closure_attempts`: auth-only durable attempt, purpose-bound challenge reference, expiry and confirmation. OTP challenge purpose `account_close` is refused by normal sign-in.
- `rights_file_deletions`: tenant-bound private profile-photo deletion queue, next retry/completion. Never used for retained care documents.

ZIP exports stay in process memory and are not stored as blobs. A prepared export request is durable; it does not prove successful delivery to a browser.

## WhatsApp service inbox (migration 47)

- `inbox_channels`: globally unique sender ID, tenant/WABA binding and creation time; immutable after first use.
- `inbox_threads`: tenant/sender, HMAC contact key, encrypted phone, last four digits, last inbound time, explicit service consent/STOP/source, optional doctor assignment, open/resolved state, unread count and revision.
- `inbox_messages`: immutable encrypted inbound/outbound content and input hash; sender/provider IDs for deduplication/correlation; direction/kind/status/times; outgoing staff/role and optional template revision. No media URLs or raw webhook payloads.
- `inbox_templates`: provider identity, name/language/category/status, encrypted body, content hash, supported/enabled flags, revision and authoritative verification time. Local enablement is not provider approval.

All tables have tenant RLS. No patient/chart association is inferred from an unverified WhatsApp number. Mixed-family transcript access/retention needs clinic review. These rows do not supply message pricing or cost reporting.

## Bulk session operations (migration 48)

`clinic_operations` retains immutable encrypted request/preview/snapshot fingerprints and the applied receipt, creator/doctor/kind/revision/expiry. `clinic_operational_updates` is append-only per operation/source appointment, with optional replacement and delay estimate. Both have tenant RLS and cross-tenant source guards. `appointments.delay_minutes` (0–240) and `delay_updated_at` annotate waiting visits without moving them. Source closure is an ordinary scoped availability exception.

`whatsapp_deliveries.operational_update_id` links generic appointment-update intents to the immutable event, deduplicated per event/sender. Its legacy appointment FK stays null; source and replacement are read through the event. Existing callback, consent-version and unknown-outcome rules remain applicable. Jobs carry delivery IDs only.


## Staff/platform second-factor OTPs (6 November 2026)

`mfa_otp_challenges` stores a UUID, unique MFA-token hash, account UUID, `staff`/`platform`
audience, keyed credential/recipient/clinic/role binding hash, keyed code hash, attempt
count (0-5), created/expiry times and delivered/consumed times. It stores no plaintext
code, phone number, password hash or MFA token. The auth role can access only staff rows;
the platform role can access only platform rows; the tenant role has no table privilege.
The table is separate from patient OTPs. Only delivered, unexpired, unconsumed challenges
with matching account/credentials can complete a password-verified MFA step.

Deployment variables `STAFF_MFA_MODE`/`PLATFORM_MFA_MODE` choose `totp`, `whatsapp` or
`disabled` independently; no account schema or per-clinic policy switch is introduced.
See [operator configuration](../runbooks/second-factor-auth.md).

## Staff sign-in contact changes (6 November 2026)

`staff_contact_changes` is an auth-only table with clinic, staff subject and initiating
admin IDs, email/phone field, encrypted new value, opaque profile/credential/membership
version, keyed code hash, attempt count, expiry/delivery/consumption/cancellation timestamps.
Only `dhc_auth` has access; tenant and platform database roles have no grant. HTTP handlers
scope admin requests to their clinic and confirmations to the authenticated staff owner.
Current User contact values are not overwritten until ownership verification completes.

## Patient demographic import provenance

`patient_import_jobs` stores tenant/creator UUIDs, a stable source label, an input SHA-256,
encrypted normalized preview/result rows, immutable creation/expiry timestamps and the
one-way preview → applied/cancelled state. Applying expires after 24 hours; this does not
erase retained encrypted history. Raw CSV and unmapped columns are not persisted.

`patient_import_records` binds clinic/source/external ID uniquely to a patient UUID,
the original normalized row hash and the creating job. Provenance is immutable. Both
tables have tenant RLS; platform/auth roles have no grant. Clinic-admin HTTP access is
audited. Owned data-rights exports include only the patient's source/external ID.

## Online consultation evidence

`online_visit_settings` stores per-clinic availability and revision, initially disabled.
`online_visits` stores an appointment-bound revision and encrypted current state: profile/
appointment/settings fingerprint, declared identity/guardian details, consent version,
holder/time, doctor check actor/time/method and private call details.
`online_visit_events` stores append-only encrypted snapshots for intake, withdrawal, call
configuration and doctor verification, unique per appointment/revision with actor/time.
All tables have tenant RLS; platform/auth roles have no grants. HTTP readers have separate
patient/assigned-doctor/operational projections. Data-rights exports exclude call secrets.
Used consultation modes cannot be rewritten; appointment locks/version checks serialize
online authorization and state changes.
