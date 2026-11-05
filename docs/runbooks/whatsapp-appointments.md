# WhatsApp appointment confirmations and reminders

This web-first increment uses the existing Meta Cloud API integration. No live credentials are needed to build or test it. Appointment sending is **off by default**.

## Enable later

First apply migrations, including `20261104130000_whatsapp_delivery` and `20261104150000_whatsapp_appointments`. Configure the sending number, Graph API version and Meta access token from [WhatsApp setup](whatsapp-otp.md). Callback verification must be enabled for receipts and STOP replies.

Set the following on both the API and workers as applicable:

```dotenv
WHATSAPP_APPOINTMENTS_ENABLED=true
WHATSAPP_WEBHOOK_ENABLED=true
WHATSAPP_PHONE_NUMBER_ID=<numeric-sender-id>
WHATSAPP_BUSINESS_ACCOUNT_ID=<numeric-whatsapp-business-account-id>
WHATSAPP_APP_SECRET=<meta-app-secret>
WHATSAPP_WEBHOOK_VERIFY_TOKEN=<random-token-at-least-32-characters>
WHATSAPP_ACCESS_TOKEN=<secret-system-user-token>
WHATSAPP_GRAPH_API_VERSION=<supported-version>
WHATSAPP_APPOINTMENT_CONFIRMATION_TEMPLATE=appointment_confirmed
WHATSAPP_APPOINTMENT_REMINDER_TEMPLATE=appointment_reminder
WHATSAPP_APPOINTMENT_TEMPLATE_LANGUAGE=en_US
WEB_BASE_URL=https://<patient-portal-host>
DATABASE_URL=<database-connection>
REDIS_URL=<redis-connection>
```

The API needs the flag, sending number and callback configuration. Workers need the flag, database, Redis, access token, version, sending number, both template names, language and an HTTPS portal address without embedded credentials. Worker startup rejects incomplete sending settings. Keep the flag false until ready. OTP settings and the authentication template remain independent.

Submit two appointment templates for Meta approval, using the category Meta approves for their purpose. Each template must have **four positional body parameters**, in this order:

1. Clinic name.
2. Appointment date in IST.
3. Appointment time in IST.
4. Public portal sign-in URL with the organisation's clinic identifier.

Suggested confirmation text: `Your appointment at {{1}} is confirmed for {{2}} at {{3}}. Open the patient portal: {{4}}. Reply STOP to stop appointment messages.`

Suggested reminder text: `Reminder: your appointment at {{1}} is on {{2}} at {{3}}. Open the patient portal: {{4}}. Reply STOP to stop appointment messages.`

No patient name, doctor specialty, diagnosis, prescription, attachment or clinical text is included. The link is the public sign-in page, not a signed appointment link or an automatic sign-in credential; a patient must sign in normally to view their records. Meta template approval and a live staging send remain operator setup steps. See [Meta's messaging policy](https://whatsappbusiness.com/policy/) and the Cloud API references in the OTP runbook.

## Explicit agreement and revocation

Staff open a live patient's page and use **WhatsApp appointment messages**. The number holder's agreement must be explicitly checked before enabling. Patient portal users manage their verified mobile number from **Privacy**. The choice applies to that number across the organisation's clinics, including family records sharing it. A record without a direct mobile number gets no messages; this increment does not automatically substitute a guardian's number.

Preferences are initially off. Enabling requires an available sender; a patient must have accepted the current account consents. Turning messages off does not require health-data consent: an existing opt-in can also be revoked on the portal's consent screen before accepting new documents. Changes are audited by preference ID and source, never phone. Repeating the same setting is idempotent.

Replying **STOP** (case-insensitive, optional surrounding spaces) to the configured WhatsApp number revokes appointment grants for that recipient on that sending number, across organisations sharing it. The callback must pass the Meta signature/account/sender checks. Only a hash of its message ID is retained for deduplication; raw text and recipient number are not stored in the opt-out event table. Older STOP timestamps cannot revoke grants recorded in a later second, and an already processed STOP cannot be replayed to undo a later re-grant. Sign-in codes are a separate, user-requested authentication flow and are not disabled by appointment opt-out.

## Scheduling and duplicate prevention

- A database outbox trigger records intent in the same transaction as a new confirmed booking or a pending booking becoming confirmed. This covers staff and patient booking paths and replacement bookings from rescheduling. A rolled-back booking creates no notification intent.
- Only an already active opt-in produces intent. Enabling after a booking does **not** backfill that booking's confirmation/reminder. Walk-ins and pending bookings do not produce messages until an eligible future booking is confirmed.
- One confirmation is due immediately; one reminder is due **24 hours before the visit**, if the booking was confirmed before that reminder time. Bookings within 24 hours get the confirmation only. Each notice has a 15-minute sending window, bounded by the visit start for confirmations; old backlogs are skipped rather than sent late.
- The dispatcher checks every ten seconds and leases due IDs for 60 seconds before publishing ID-only jobs to BullMQ's `messaging` queue. Database/queue failures before a send can retry safely. Unique appointment/kind/time/sender keys prevent duplicate intent.
- Cancellation, rescheduling away, check-in or an in-place time/patient change invalidates queued notices immediately. At send authorization the worker rechecks active organisation/clinic/doctor/consultation type, appointment status and time, live patient and number, and the exact consent revision. A phone change, merge or opt-out prevents a queued old notice from being sent.
- A notice transitions to Sending before the external call. Only one worker can authorize it. The external request has a ten-second limit and is attempted once. Explicit 4xx rejection becomes Send request failed; transport/5xx/malformed response becomes Send status unknown. A crash left in Sending becomes unknown after two minutes. It is **never automatically resent**, because Meta might already have accepted it. This trades possible missed messages for avoiding duplicate sends.
- A cancellation or opt-out cannot recall a request already authorized and handed to Meta. Late callbacks may still establish sent/delivered/read/failed evidence; stronger delivered/read states never regress.

## Delivery log and operations

Clinic admins use **WhatsApp delivery**. The Message column distinguishes sign-in codes, confirmations and reminders. Scheduled, Sending, Skipped and Send status unknown supplement the existing receipt statuses. The API accepts an optional `kind=appointment_confirmation` or `kind=appointment_reminder` filter. No recipient, patient, appointment or provider message IDs are returned.

Unknown sends require checking Meta's operational dashboard before any manual follow-up; there is no automatic resend button. Receipt-processing jobs still retry idempotently as before. Contact data is fetched from the database only when a valid due notice starts and is never put into Redis jobs. PostgreSQL connections explicitly use UTC; user-facing dates and template times are formatted in IST, regardless of the cluster's default timezone.

For staging acceptance, opt in a consented test number, create a future confirmed booking, confirm one confirmation, inspect its receipt, and verify the reminder schedule. Test cancellation, changed phone, opt-out/STOP, duplicate jobs and an uncertain send. Live Meta and Redis-backed sending must be smoke-tested after environment configuration; synthetic tests use no real patients and send no external messages.
