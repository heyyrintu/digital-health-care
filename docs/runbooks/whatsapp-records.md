# WhatsApp record-ready notices

Apply all database migrations and deploy matching API/workers/web builds. Read [ADR 0020](../adr/0020-authenticated-record-notification-links.md) and the existing [callback/OTP](whatsapp-otp.md) and [appointment](whatsapp-appointments.md) runbooks.

Keep `WHATSAPP_RECORDS_ENABLED=false` until ready. API requires verified webhook/STOP configuration, sender ID and `WHATSAPP_RECORD_LINK_SECRET` (a separate random secret of at least 32 characters). Workers need the identical secret, database/Redis access, Meta access token/sender/explicit Graph version, public HTTPS `WEB_BASE_URL`, `WHATSAPP_RECORD_TEMPLATE` and `WHATSAPP_RECORD_TEMPLATE_LANGUAGE`. Appointment templates are not required if only record sending is enabled.

Create and obtain approval for a generic template, for example: “A new record is available from your clinic. Sign in securely to view it: {{1}}. This link expires in one hour. Reply STOP to stop optional messages.” Use exactly one body parameter, the link; do not add clinical content or patient names. Match the approved template configuration exactly.

Record explicit recipient agreement using the staff patient card or the patient's Privacy page. Consent covers that direct mobile number across the practice; appointment consent is separate. New sign/share events queue notices. Enabling consent does not send old records. Workers send within 24 hours, with a one-hour navigation link issued at authorization. The portal still requires patient sign-in and current health consent. Existing source rules remain: superseded/void prescriptions and withdrawn documents do not resolve; closing a referral preserves its letter.

Pilot with one consenting test number: sign/share each source, verify the generic message, patient login continuation, family-only file access, delivery callbacks, withdrawal/void/supersession checks and STOP. No live messages are sent by automated tests. Inspect the admin delivery log by kind/state; no recipients or clinical text appear there. Confirm the messaging worker and dispatcher run continuously and the durable inbox/outbox drains.

Disable the flag on both API and workers to stop new submissions. Queued notices expire; uncertain notices are never automatically resent. Disabling cannot recall an in-flight/accepted message. Revocation cancels queued notices and prevents later authorization. Expired links require opening records directly from the portal; rotating the shared secret invalidates existing links.
