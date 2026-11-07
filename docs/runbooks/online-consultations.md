# Set up web online consultations

## Clinic configuration

1. Deploy the API/web changes and apply migrations. No additional video-provider secret
   is needed for this external-call workflow. Online consultations default off per clinic.
2. Set up real doctor names, council/registration and qualifications through the existing
   People/profile workflow and platform registration verification. Pending or incomplete
   doctor profiles cannot take online self-bookings or authorize online intake.
3. Create a separate audio or video consultation type and its clinic/doctor availability.
   Leave **requires prepayment** off: online checkout is not included in this increment.
   Agree how the clinic will collect any fee using its existing billing workflow.
4. As clinic admin, open **Online consultation**, enable it and choose **Save online settings**.
   Changing/saving these settings invalidates earlier online snapshots. Avoid changing
   global availability during active online visits without arranging renewed intake.
5. Patients can now select eligible audio/video types when self-booking. Staff can also
   schedule them through existing appointment controls. A used consultation type's mode
   cannot be edited; create a new type for another mode. Rebook when a different mode is
   required rather than rewriting the old appointment's mode/history.

## One appointment

1. Front desk/admin or the assigned doctor opens the visit under **Online consultation**.
   For video, enter a direct HTTPS meeting link of at most 1,000 characters. Supported
   examples: `https://meet.google.com/abc-defg-hij`,
   `https://zoom.us/j/123456789?pwd=...`, a `*.zoom.us` join link,
   `https://teams.microsoft.com/l/meetup-join/.../0` or a Teams `/meet/...` link.
   Use actual clinic-controlled rooms, not these examples. Custom domains, arbitrary
   redirects and embedded URL credentials are not accepted.
2. For audio, enter only the clinic's intended `+91` mobile call number. Video accepts
   only a meeting link; audio accepts only a phone number. Save the call details.
3. In **Appointments**, the patient opens **Online consultation**. They see the booked
   patient/UHID, doctor name/qualifications/registration/council, provider name, limitations
   and consent text. They enter/confirm identity and current address, provide a guardian
   for a minor and explicitly save consent for this appointment.
4. Make sure the profile birth date is recorded and accurate. The declaration does not
   silently update it. A missing date has a profile-edit link; a correction invalidates
   previous online details, so refresh/reconfigure call details and renew consent.
5. Joining opens 15 minutes before the start and closes 60 minutes after the end, only
   for a live confirmed/checked-in/in-consultation appointment with current consents.
   The patient's Connect button asks the server to authorize access immediately before
   opening the external service/phone handler. It does not mark a visit completed or
   prove a connection. An audio client needs an available phone handler.
6. The assigned doctor opens the same visit, compares the declaration with the booked
   patient, checks identity/age and any guardian's adult authority/presence, confirms
   credentials and willingness to continue, and assesses whether the booked mode is
   suitable. Choose the matching audio/video method and confirm the doctor check.
   Normal check-in/start controls still apply. Starting or signing is blocked until
   readiness passes; existing prescription safety and signing-PIN checks still apply.

No automated government identity check or guardian document verification is provided.
No in-app media, recording, meeting creation, automatic reminders for this new workflow,
online prepayment or provider call-state synchronization is added here.

## Privacy, withdrawal and recovery

- Use a private room per appointment or strict provider waiting-room admission. The
  clinic owns provider security, recording policy, patient admission and room revocation.
- Withdrawing online consent blocks new join authorization, start and signing. It does
  not erase prior consent/care history. The withdrawal button remains available without
  current health-data consent. Health-data withdrawal itself blocks new authorization.
- A released provider URL or phone number cannot be recalled. Stop the external call and
  revoke provider admission when needed; an application's disabled button cannot enforce
  disconnection in another service.
- Profile/contact/guardian or appointment changes invalidate the prior snapshot. Refresh
  before editing. Staff must save current call details, the patient must renew identity/
  consent and the assigned doctor must verify again. Cancelled/completed visits cannot
  issue new join access. A no-show or merged/closed record is not eligible either.
- After an interrupted save or a stale-version error, use **Reload online details**.
  Inspect the returned current state before submitting another change. Mutations use
  version checks and retain immutable encrypted snapshots; do not delete history to retry.
- Existing signed documents remain retained. Online signing, including amendment signing,
  currently requires current readiness; review correction/retention scenarios during
  clinic acceptance and do not infer automatic exemptions.

Before a real rollout, obtain clinic/clinical/policy acceptance of the consent text and
identity/age/guardian procedure, rehearse one authorised call and withdrawal in the real
provider, check admission settings, billing, private exports, accessibility and failure
recovery. Development browser tests intercept the provider and never make a real call.
