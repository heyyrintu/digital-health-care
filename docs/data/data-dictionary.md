# Data Dictionary

**Status:** Draft · **Owner:** Backend lead · **Update:** with every migration.

Conventions for every table: `id` (UUID), `organisationId` (except platform-level User/Device), `createdAt`, `updatedAt`, `deletedAt` where soft delete applies. Files are stored by S3 key, never by public URL. Fields marked *(encrypted)* use field-level encryption. Row-level security filters every query by `organisationId` (ADR 0014). Database columns are snake_case (`organisation_id`); this document uses the camelCase field names.

**Implemented so far (Phase 0):** Organisation, User, Membership, StaffInvite, Session, OtpChallenge, Patient (minimal fields) and AuditLog — see `packages/db/prisma/schema.prisma`. Everything else below is the target design.

## Platform and identity

| Entity | Purpose | Key fields |
|---|---|---|
| Organisation | Practice or clinic group (tenant) | id, slug (unique, used in sign-in and clinic links), name, legalName, status, chartModel (shared|own_patients), brandingId, settings (JSON) |
| Branding | Per-organisation look and senders | organisationId, displayName, logoKey, colours, customDomain, whatsappSender, smsSenderId, emailDomain, googleReviewUrl |
| Clinic | Physical location | organisationId, name, address, geo, phone, gstin?, timezone, hfrId |
| User | Platform-level login identity (no organisationId) | phone (unique), email (unique), displayName, status, passwordHash (staff, scrypt), mfaSecret (staff, encrypted), mfaPendingSecret (encrypted, set during invite acceptance until the first code), mfaLastUsedStep (TOTP replay guard), failedLoginCount, lockedUntil, lastLoginAt |
| Membership | A user's role in one organisation; the auth link to tenants | organisationId, userId, role (patient|doctor|front_desk|clinic_admin), status (invited|active|revoked) |
| StaffInvite | Single-use link to set up a staff account | organisationId, userId, role, purpose (join|reset), tokenHash, createdByUserId, expiresAt (72 h), acceptedAt, revokedAt |
| Session | Refresh-token session on one device | userId, organisationId, role, refreshTokenHash, previousRefreshTokenHash (reuse detection), deviceId, userAgent, ip, expiresAt, lastUsedAt, revokedAt, revokedReason |
| OtpChallenge | Patient sign-in code | phone, organisationId, codeHash (HMAC), attempts, expiresAt, consumedAt |
| Device | Registered device | userId, platform, model, pushToken, biometricKeyId, lastSeenAt, revokedAt |
| StaffMember | Staff profile in an organisation (role lives on Membership) | userId, organisationId, assignedDoctorIds |
| Doctor | Doctor profile | userId, organisationId, name, qualifications, specialty, registrationNumber, council, hprId, rxNumberPrefix, signingProviderRef |
| DoctorClinic | Doctor practises at clinic | doctorId, clinicId, active, consultationTypeIds |
| DoctorOnboarding | Onboarding state | doctorId, status (invited|pending_verification|verified|active|suspended), registrationDocKey, verifiedBy, verifiedAt, checklist (JSON) |

## Patients

| Entity | Purpose | Key fields |
|---|---|---|
| Patient | Person receiving care | organisationId, accountUserId, uhid (unique per org), name, dob, gender, relationToAccount, guardianPatientId, phone, address, emergencyContact, bloodGroup, language, mergedIntoId |
| Tag / PatientTag | Configurable labels | Tag: organisationId, name, colour, sortToTop · PatientTag: patientId, tagId, addedBy |
| Allergy | Recorded allergy | patientId, substance, class, reaction, severity, source (patient|doctor), verifiedByDoctor |
| MedicalCondition | Chronic condition | patientId, condition, code?, since, status, verified |
| CurrentMedication | Ongoing medicine | patientId, medicineName, moleculeId?, dose, since, source |
| Consent | Recorded consent | patientId, type (data_processing|telemedicine|guardian|scribe|abdm), version, givenBy, givenAt, withdrawnAt, context (consultationId?) |
| MessagingOptIn | Channel opt-in | patientId, channel (whatsapp|sms|email|push), status, source, at |
| AbhaLink | ABHA linked to patient | patientId, abhaNumber (encrypted), abhaAddress, linkedVia, verifiedAt, status |

## Scheduling

| Entity | Purpose | Key fields |
|---|---|---|
| ConsultationType | Mode and pricing | organisationId, name, mode (in_person|audio|video), defaultDurationMin, fee, followUpFee, requiresPrepayment, active |
| AvailabilityVersion | Weekly schedule version | doctorId, clinicId, consultationTypeId, effectiveFrom, weekdays/sessions (JSON), slotMin, bufferMin, breaks |
| AvailabilityException | Leave, holiday, extra session | doctorId, startDate, endDate, type, startTime?, endTime?, reason |
| Appointment | Booking | patientId, doctorId, clinicId, consultationTypeId, startAt, endAt, status, source (app|web|front_desk|walk_in|scan_share), tokenNumber, reason, joinInfo, rescheduledFromId, cancelReason, overbook, holdExpiresAt |
| AppointmentStatusHistory | Status timeline | appointmentId, fromStatus, toStatus, actorUserId, at, note |
| VisitTiming | Consultation duration | appointmentId, startedAt, endedAt |

## Clinical

| Entity | Purpose | Key fields |
|---|---|---|
| Consultation | Visit record | appointmentId, patientId, doctorId, mode, chiefComplaint, symptoms, examination (JSON, specialty template), diagnosisText, icd10Codes, plan, privateNotes (encrypted), advice, followUpDate, lockedAt |
| Vitals | Measurements | consultationId, patientId, bp, pulse, tempC, spo2, weightKg, heightCm, bmi, painScore, pregnancyStatus, breastfeeding, recordedBy, recordedAt |
| ScribeSession | AI scribe run | consultationId, mode (ambient|dictation), consentId, language, audioKey, audioDeletedAt, transcript (encrypted), draft (JSON), acceptedSections, modelVersion, promptVersion, status |
| AssessmentForm / Assessment | Questionnaires | Form: organisationId, name, questions (JSON), scoring · Assessment: formId, patientId, answers, score, completedAt, source |
| AskAiQuery | Ask AI log | patientId, doctorId, question, answer, citations (JSON), modelVersion, at |

## Prescribing

| Entity | Purpose | Key fields |
|---|---|---|
| DrugMolecule | Licensed drug data | name, class, interactionRefs, pregnancySafety, lactationSafety, maxDailyDose, paediatricDoseRange, geriatricCaution, renalAdjustment, hepaticCaution, weightBased, telemedicineList |
| Medicine | Brand in the master | brandName, moleculeIds, strength, form, scheduleTag, active, source (licensed|clinic_added) |
| PrescriptionTemplate | Saved prescription | doctorId, name, items (JSON), advice, tests |
| Prescription | Prescription document | consultationId, patientId, doctorId, prescriptionNumber (prefix + sequence), version, previousVersionId, status (draft|signed|published|amended|void), signatureMethod, signedAt, pdfKey, pdfHash, templateVersion, verificationCode, voidReason, language |
| PrescriptionItem | Medicine line | prescriptionId, medicineId?, nameSnapshot, compositionSnapshot, dose, frequency, timing, duration, route, quantity, remarks (generated, editable), sortOrder |
| PrescriptionTest | Test on prescription | prescriptionId, testOrderId |
| SafetyAlert | Alert and action | prescriptionId, itemId, checkType, severity (block|warn|info), message, action (accepted|changed|overridden), overrideReason, doctorId, at |

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
| PriceListItem | Chargeable item | organisationId, name, amount, category, active |
| Bill / BillItem | Charges for a visit | Bill: appointmentId, patientId, total, discount, status · BillItem: billId, priceListItemId?, description, amount |
| PaymentGatewayAccount | Cashfree account per organisation | organisationId, provider (cashfree), mode (sandbox|production), keyRef (secret store, encrypted), kycStatus, methodsEnabled |
| Payment | Payment attempt | billId, method (cash|upi|card|netbanking|wallet|counter_upi|counter_card), channel (link|in_app|web|counter), gateway, gatewayOrderId, gatewayPaymentId, paymentLinkId, amount, gatewayFee, status, paidAt, settledAt |
| PaymentLink | Cashfree link | billId, gatewayLinkId, expiresAt, status, sentVia |
| Refund | Refund | paymentId, amount, reason, gatewayRefundId, status, requestedBy |
| Settlement | Cashfree settlement | organisationId, gatewaySettlementId, date, gross, fees, net, matchedAt |
| Receipt | Numbered receipt | billId, receiptNumber, pdfKey, issuedAt |

## Messaging

| Entity | Purpose | Key fields |
|---|---|---|
| MessageTemplate | Template per channel | organisationId, key, channel, language, body, category (utility|authentication|marketing), dltTemplateId?, approvalStatus |
| Notification | Outgoing message | organisationId, patientId?, userId?, templateKey, channel, status, cost, providerMessageId, sentAt, readAt |
| DeliveryLog | Delivery events | notificationId, status, at, retry, fallbackTriggered |
| MessageThread | Inbound conversations | organisationId, patientId, channel, lastInboundAt, assignedTo |
| WebhookEvent | Inbound webhook store | provider, eventId, organisationId, signatureValid, receivedAt, processedAt, result |

## ABDM

| Entity | Purpose | Key fields |
|---|---|---|
| CareContext | Linked record | patientId, abhaLinkId, consultationId, referenceNumber, linkedAt |
| HealthConsent | Consent artefact | patientId, requesterType (HIP|HIU), purpose, hiTypes, dateRange, expiresAt, status, artefactId |
| ExternalRecord | Fetched record | patientId, consentId, sourceFacility, fhirBundleKey, fetchedAt |

## Governance

| Entity | Purpose | Key fields |
|---|---|---|
| AuditLog | Append-only audit (trigger blocks update/delete) | organisationId (null for platform events), actorUserId, action, entityType, entityId, requestId, ip, userAgent, at, metadata (IDs and reasons only, no patient data) |
| DataRightsRequest | DPDP request | userId, type (access|correction|erasure), status, handledBy, closedAt |
| ImportJob | Migration import | organisationId, files, mapping, dryRunReport, status, startedBy, completedAt |

## Retention classes

| Class | Entities | Rule |
|---|---|---|
| Clinical | Consultation, Vitals, Prescription(+Item, Alert), TestOrder/Result, Referral, ScribeSession transcript | At least 3 years (legal minimum; confirm with lawyer); never patient-deletable |
| Audio | ScribeSession.audioKey | Deleted after retention window (default 7 days) |
| Financial | Bill, Payment, Refund, Settlement, Receipt | As required for financial records (confirm with CA) |
| Patient uploads | MedicalDocument (non-referenced) | Patient-deletable |
| Logs | AuditLog | Append-only; retained per security policy |
