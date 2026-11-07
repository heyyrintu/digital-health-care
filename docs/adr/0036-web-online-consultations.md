# ADR 0036: web online consultations

Status: implemented locally, 7 November 2026. Real-call, clinical/policy and hosted
acceptance remain separate. No in-app video or telemedicine checkout is claimed.

## Decision

Online consultations use the clinic's external Google Meet, Zoom or Teams meeting link,
or a clinic Indian mobile number for audio. This app does not create meeting rooms,
record calls, prove connection/duration or provide an emergency service. The clinic owns
provider admission, privacy settings and call handling. Links are direct HTTPS meeting
paths on supported hosts; lookalikes, credentials, custom ports, fragments and arbitrary
redirect paths are rejected. The server never fetches a supplied meeting URL.

Clinic admins explicitly enable the feature per organisation; it defaults off. Portal
booking then advertises active non-prepaid audio/video types alongside existing in-person
types. Online booking needs an active doctor with display name and verified registration
profile. Types requiring prepayment remain excluded for online bookings. Existing clinic
billing and collection are separate; the booking copy says payment must be arranged with
the clinic. Used consultation-type modes are frozen, and existing appointments cannot be
switched across modes. Create a fresh type/booking for a different mode.

Patients or their verified number's family account submit a visit-specific identity
declaration and explicit consent version `online-2026-11-07`. The declaration contains name,
birth date, current address and, for minors, adult guardian name/relationship and authority
acknowledgement. It does not silently change the patient profile or establish government-ID
verification. Adulthood uses India calendar dates. A recorded birth date must match the
declaration; a doctor cannot verify an unknown/mismatched profile birth date. Complete or
correct the profile first, then renew the online intake after the profile change.

The assigned doctor sees both the booked patient/UHID/profile birth date and the declared
identity. They explicitly confirm identity and age, guardian presence/authority when
applicable, availability of their credentials, willingness to continue and suitability of
the booked mode. Audio/video verification methods must match that mode. Other doctors
cannot view or verify this intake. Front desk/admin can manage operational call details
but receive no declared identity payload through this endpoint. Existing permissions for
the patient register and clinical record remain in force.

Starting and signing an online visit recheck enabled settings, current verified doctor,
patient/guardian state, the current verified consent holder and active membership, current
care consents, appointment/profile snapshot, explicit online consent and assigned-doctor
verification. Old declarations or copied browser state do not satisfy the check. Existing
in-person consultation behavior remains unchanged. This increment applies readiness checks
to online signing, including signing an amendment; clinical rollout must review that
behavior alongside the existing correction/retention workflows.

## Joining and withdrawal

The patient may resolve call details only through an authenticated POST for their owned
appointment, with current care/online consent and a verified doctor, while it is confirmed,
checked in or in consultation. The window is 15 minutes before start through 60 minutes
after end. The patient needs to join before a doctor can check identity by call, so joining
does not require the doctor's completed identity check; starting/signing does. A normal
patient GET returns the provider name and availability, never the private meeting URL or
call number. Join authorization is audited; it is not proof that a call connected.

Withdrawal is available without reaccepting care consent. It closes further join
authorizations and invalidates doctor verification. Cancellation, closure, merges, disabled
accounts, changed contacts, expired join windows and settings changes also suppress use.
Changing patient/guardian profile details or the appointment's patient/doctor/site/type/time
invalidates the snapshot and clears usable call details, consent and verification. Staff
must configure current call details and the patient/doctor must complete the steps again.
Saving clinic settings increments a revision and invalidates existing snapshots as well.

Already released links/numbers cannot be recalled by this application. Withdrawal does
not terminate a provider call or revoke a copied link. The doctor/clinic must stop the call
and enforce provider admission/revocation. Use appointment-specific private rooms or strict
waiting-room admission; do not treat this application's join window as provider security.

## Evidence and limits

All online state and per-revision identity/consent/call/verification snapshots are encrypted.
Tenant RLS, immutable event history, version checks and appointment locks protect access
and concurrent mutations. Unknown write outcomes are recovered by reloading the current
revision; stale retries cannot repeat a change. Audit rows contain action/actor/entity IDs,
not identity text or call credentials. Owned patient downloads include their consent and
doctor-check history, without meeting credentials or other patients' batches.

This is a product implementation informed by the identity and consent sections of the
[official telemedicine guidance](https://www.mohfw.gov.in/pdf/Telemedicine.pdf); it is not
a determination of legal sufficiency or a replacement for a clinician's identity/age,
guardian-authority or suitability assessment. Clinical/policy review, real provider
admission/withdrawal rehearsal and verified clinic/doctor details remain launch acceptance.
No prescription safety rules were relaxed; licensed clinical data and production cloud
signing remain separate existing requirements. See [operator setup](../runbooks/online-consultations.md).

Validation: 57 migrations applied to disposable PostgreSQL. All 117 targeted integration
tests passed across eight suites, including 15 online cases and existing scheduling,
booking, clinical, prescription, signing and export behavior. The final online suite passed
again after India-calendar age checks. All 26 scoped lint/type/unit-check tasks passed;
the unit cases include provider URL restrictions and birthday boundaries. Eight browser
checks passed across online visits and existing portal/profile workflows, including
390px/1280px online self-booking, identity, doctor verification, intercepted external
joining and withdrawal. API/web production builds, formatting and diff checks passed.
These are synthetic local checks, not real calls, legal/clinical approval or deployment.
