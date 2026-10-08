# Data Dictionary

**Status:** Draft · **Owner:** Backend lead · **Update:** with every migration.

Conventions for every table: `id` (UUID), `organisationId` (except platform-level User/Device), `createdAt`, `updatedAt`, `deletedAt` where soft delete applies. Files are stored by S3 key, never by public URL. Fields marked *(encrypted)* use field-level encryption. Row-level security filters every query by `organisationId` (ADR 0014). Database columns are snake_case (`organisation_id`); this document uses the camelCase field names.

**Implemented so far:** Organisation, User, Membership, StaffInvite, Session, OtpChallenge and AuditLog (Phase 0); Patient, UhidSettings, Tag and PatientTag (patient register); Clinic, ConsultationType, BookingRules, AvailabilityVersion and AvailabilityException (availability); Appointment and AppointmentStatusHistory (appointments); DisplayScreen (queue); PriceListItem, Bill, BillItem, Payment and ReceiptSettings (billing and counter payments) — see `packages/db/prisma/schema.prisma`. Everything else below is the target design.

## Platform and identity

| Entity | Purpose | Key fields |
|---|---|---|
| Organisation | Practice or clinic group (tenant) | id, slug (unique, used in sign-in and clinic links), name, legalName, status, chartModel (shared\|own_patients), brandingId, settings (JSON) |
| Branding | Per-organisation look and senders | organisationId, displayName, logoKey, colours, customDomain, whatsappSender, smsSenderId, emailDomain, googleReviewUrl |
| Clinic | Physical location (built: name unique per org, address, phone, timezone default Asia/Kolkata, active) | organisationId, name, address, geo, phone, gstin?, timezone, hfrId, active |
| User | Platform-level login identity (no organisationId) | phone (unique), email (unique), displayName, status, passwordHash (staff, scrypt), mfaSecret (staff, encrypted), mfaPendingSecret (encrypted, set during invite acceptance until the first code), mfaLastUsedStep (TOTP replay guard), failedLoginCount, lockedUntil, lastLoginAt |
| Membership | A user's role in one organisation; the auth link to tenants | organisationId, userId, role (patient\|doctor\|front_desk\|clinic_admin), status (invited\|active\|revoked) |
| StaffInvite | Single-use link to set up a staff account | organisationId, userId, role, purpose (join\|reset), tokenHash, createdByUserId, expiresAt (72 h), acceptedAt, revokedAt |
| Session | Refresh-token session on one device | userId, organisationId, role, refreshTokenHash, previousRefreshTokenHash (reuse detection), deviceId, userAgent, ip, expiresAt, lastUsedAt, revokedAt, revokedReason |
| OtpChallenge | Patient sign-in code | phone, organisationId, codeHash (HMAC), attempts, expiresAt, consumedAt |
| Device | Registered device | userId, platform, model, pushToken, biometricKeyId, lastSeenAt, revokedAt |
| StaffMember | Staff profile in an organisation (role lives on Membership) | userId, organisationId, assignedDoctorIds |
| DoctorProfile | A doctor's prescription pad and signing details, per organisation (built) | organisationId, userId (unique together), registrationNumber, council, qualifications, specialty, rxPrefix (1–8 capitals or digits, unique per organisation), rxSequence (last number given), paperSize (a4\|a5), verification (pending\|verified; changing the registration number or council resets it), verifiedAt, verifiedBy (operator and ticket), signingPinHash (scrypt of a server-keyed digest of the PIN), pinFailedCount, pinLockedUntil · planned: hprId, signingProviderRef |
| DoctorClinic | Doctor practises at clinic | doctorId, clinicId, active, consultationTypeIds |
| DoctorOnboarding | Onboarding state | doctorId, status (invited\|pending_verification\|verified\|active\|suspended), registrationDocKey, verifiedBy, verifiedAt, checklist (JSON) |

## Patients

| Entity | Purpose | Key fields |
|---|---|---|
| Patient | Person receiving care | organisationId, accountUserId, uhid (unique per org), name, phone (E.164; family members may share one), dob, gender (female\|male\|other), email, address, bloodGroup, language (en\|hi), emergencyContactName, emergencyContactPhone, guardianPatientId (one level: a guardian has no guardian), createdByUserId, mergedIntoId (planned) |
| UhidSettings | Per-organisation UHID numbering | organisationId (key), prefix (up to 8 letters or digits), nextNumber (default 10001); UHID = prefix + number, e.g. EK10001 |
| Tag / PatientTag | Configurable labels | Tag: organisationId, name (unique per org), colour (#rrggbb), sortToTop, archivedAt (archived, never deleted) · PatientTag: organisationId, patientId, tagId, addedByUserId, createdAt |
| Allergy | Recorded allergy (built) | patientId, substance, reaction, source (doctor\|patient; patient = unverified), recordedByUserId, createdAt, removedAt, removedByUserId, removedReason (removed, never deleted) · planned: class/molecule link for the safety engine, severity |
| MedicalCondition | Known condition (built) | patientId, name, icd10Code?, source, recordedByUserId, createdAt, removedAt, removedByUserId, removedReason · planned: since |
| CurrentMedication | Ongoing medicine from elsewhere (built) | patientId, name, dose?, source, recordedByUserId, createdAt, removedAt, removedByUserId, removedReason · planned: moleculeId, since |
| Consent | Recorded consent | patientId, type (data_processing\|telemedicine\|guardian\|scribe\|abdm), version, givenBy, givenAt, withdrawnAt, context (consultationId?) |
| MessagingOptIn | Channel opt-in | patientId, channel (whatsapp\|sms\|email\|push), status, source, at |
| AbhaLink | ABHA linked to patient | patientId, abhaNumber (encrypted), abhaAddress, linkedVia, verifiedAt, status |

## Scheduling

| Entity | Purpose | Key fields |
|---|---|---|
| ConsultationType | Mode and pricing | organisationId, name (unique per org), mode (in_person\|audio\|video), defaultDurationMin (5–240), feePaise, followUpFeePaise?, requiresPrepayment, active |
| BookingRules | Booking window and limits (built; more rules to come) | organisationId (key), horizonDays (default 30, 1–365), sameDayCutoffMinutes (default 60, 0–1440), overbookPerDay (default 2, 0–50; per doctor per day) |
| AvailabilityVersion | Weekly schedule version; never edited, a new one takes over from its date | organisationId, doctorUserId, clinicId, consultationTypeId, effectiveFrom (date, unique with doctor + clinic + type), weekly (JSON: `{mon: [{start, end}]}`, IST `HH:MM`; gaps between sessions are breaks), slotMinutes (5–240), bufferMinutes (0–120), createdByUserId |
| AvailabilityException | Leave (a doctor), holiday (a clinic, or every clinic when clinicId is empty), extra session (doctor + clinic + type) | organisationId, type (leave\|holiday\|extra_session), doctorUserId?, clinicId?, consultationTypeId?, startDate, endDate, startTime?, endTime? (both or neither; none = whole day), reason?, createdByUserId |
| Appointment | Booking or walk-in (built; never deleted) | organisationId, patientId, doctorUserId, clinicId, consultationTypeId, date (IST day of the queue), startAt, endAt, status (pending\|confirmed\|checked_in\|in_consultation\|completed\|cancelled\|no_show\|rescheduled), source (front_desk\|walk_in\|app\|web; scan_share planned), tokenNumber (per doctor + clinic + day, unique), overbook, reason, cancelReason, rescheduledFromId (unique: the booking this one replaced), checkedInAt, consultationStartedAt, completedAt (visit timing), createdByUserId; planned: joinInfo, holdExpiresAt |
| AppointmentStatusHistory | Status timeline (built; append-only) | organisationId, appointmentId, fromStatus (empty when created), toStatus, actorUserId, at, note (cancel reason) |
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
| Medicine | Medicine in the master (built) | organisationId (null = platform reference master; clinics read it but cannot change it), name, genericName, composition, form, ingredients (MedicineIngredient), defaultRoute, source (reference\|clinic), active (inactive medicines are hidden and cannot be prescribed) · planned: scheduleTag. Clinics add, edit and deactivate their own (§3k of the API guide); brand names typed by doctors map to a medicine through MedicineRequest |
| MedicineRequest | The clinic admin's decision on a medicine name doctors typed (built; row-level security per organisation) | organisationId, nameKey (lower case, single spaces; unique per organisation), name (as typed), decision (approved\|rejected), medicineId (set exactly when approved: a reference medicine or this clinic's), reason (required when rejected), decidedByUserId, decidedAt. The queue itself is not stored: it is worked out from PrescriptionItem rows with no medicineId. Deleting the row (undo) returns the name to the queue |
| PrescriptionTemplate | Saved prescription (built) | organisationId, doctorUserId, name (unique per doctor within the organisation), items (JSON lines without IDs) · planned: advice, tests |
| Prescription | Prescription document, one row per version (built; immutable once signed, enforced by database triggers) | appointmentId, patientId, doctorUserId, version (1, then one more per amendment), status (draft\|signed\|superseded\|void), language, revision, amendsPrescriptionId + amendmentReason (amendments), number (doctor's prefix + running number, kept by amendments), signedAt, pdfFileKey + pdfSha256 (the signed file by storage key, and its hash), templateVersion, paperSize, signatureMethod (test_key\|cloud_dsc), signature (over the PDF's SHA-256), signerCertificate, verificationCode (printed in the QR), supersededAt, voidedAt, voidedByUserId, voidReason, voidPdfFileKey (the copy stamped VOID; the signed file is kept) |
| PrescriptionVerification | Public QR lookup (built; readable without a session, holds no clinical data) | codeHash (SHA-256 of the code), organisationId, prescriptionId |
| PrescriptionItem | Medicine line (built) | id (client-chosen UUID), prescriptionId, medicineId?, name, composition, form (snapshots), route, timing, steps (JSON: dose, frequency, durationValue, durationUnit; several for tapering), quantity, instructions, remarks (generated unless remarksEdited), sortOrder |
| PrescriptionTest | Test on prescription | prescriptionId, testOrderId |
| SafetyAlert | The safety log: an alert and the doctor's answer (built; never deleted) | prescriptionId, key (rule, line, subject; unique per prescription), ruleId, itemId?, severity (block\|warn\|info), overridable, message, params, firstShownAt, lastShownAt, resolvedAt? (set while the alert no longer fires), action? (acknowledged\|overridden\|changed; null while unanswered), reason?, actionByUserId?, actionAt?, drugDatabaseVersion |

## Orders and documents

| Entity | Purpose | Key fields |
|---|---|---|
| TestOrder / TestResult | Investigations | Order: patientId, consultationId, test, region, side, status · Result: orderId, documentId, uploadedBy, reviewedAt |
| Referral | Referral | patientId, fromDoctorId, toDoctorId? or external details, reason, urgency, letterPdfKey, status |
| Attachment | Document sent to patient | patientId, documentKey, title, sentVia, sentAt |
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
| Clinical | Consultation, Vitals, Prescription(+Item, Alert), TestOrder/Result, Referral, ScribeSession transcript | At least 3 years (legal minimum; confirm with lawyer); never patient-deletable |
| Audio | ScribeSession.audioKey | Deleted after retention window (default 7 days) |
| Financial | Bill, Payment, Refund, Settlement, Receipt | As required for financial records (confirm with CA) |
| Patient uploads | MedicalDocument (non-referenced) | Patient-deletable |
| Logs | AuditLog | Append-only; retained per security policy |
