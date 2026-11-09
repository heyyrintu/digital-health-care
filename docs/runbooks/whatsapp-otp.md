# Meta WhatsApp patient sign-in codes

Provider decision: Meta WhatsApp Cloud API directly; WhatsApp only for now (4 November 2026). This increment sends patient authentication codes, not clinical documents or general notifications.

For the currently hosted domain and Coolify activation steps, follow [the hosted WhatsApp setup guide](whatsapp-cloud-api-setup.md). It includes the Compose references required to override the preview's disabled OTP setting.

## Account setup

1. Set up a Meta business app with WhatsApp, a WhatsApp Business Account and a registered sending phone number. For staging, use Meta's test number and verified test recipients.
2. Provision a system-user access token with access to that number and `whatsapp_business_messaging`. Store it in the deployment's secret manager; never paste it into tickets, commits or logs. Use the phone number **ID**, not the displayed phone number or the business account ID.
3. Create and obtain approval for an **Authentication** template with a **Copy code** button. Set its expiry notice to five minutes, matching the server's five-minute OTP lifetime. Use a template delivery lifetime no longer than that expiry where Meta supports it. Do not use `hello_world`, a marketing template or a custom free-text message for login codes.
4. Record the template's exact name and approved language code. This first increment uses one configured template language for every sign-in. A per-patient template language and one-tap/zero-tap autofill are not implemented.
5. Choose a supported Graph API version for the Meta app. Version is explicit configuration, not an automatically changing default. The synthetic tests use `v23.0` to check URL construction; confirm support in Meta before selecting a live version.

References: [Meta Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api/), [authentication templates](https://developers.facebook.com/docs/whatsapp/business-management-api/authentication-templates), [Meta's official Postman collection](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api).

## Server configuration

Set these in the API environment; all five WhatsApp settings are required when WhatsApp delivery is selected:

```dotenv
OTP_DELIVERY=whatsapp
WHATSAPP_ACCESS_TOKEN=<secret-system-user-token>
WHATSAPP_PHONE_NUMBER_ID=<numeric-meta-phone-number-id>
WHATSAPP_GRAPH_API_VERSION=<supported-version>
WHATSAPP_OTP_TEMPLATE_NAME=patient_sign_in
WHATSAPP_OTP_TEMPLATE_LANGUAGE=en_US
```

The placeholders must be replaced. Missing or malformed settings prevent startup. `OTP_DELIVERY=disabled` refuses sends; `log` is for development only and is forbidden in production. There is no automatic SMS fallback. Local tests inject a fake sender and do not send real messages.

One server-level sending number/template is shared by the organisations on that deployment. Organisation-specific Meta accounts, billing and credentials are not implemented. Confirm the sender identity is appropriate for all clinics before enabling a shared deployment.

## Delivery behaviour

- The server creates the same six-digit, five-minute challenge as before; only its keyed hash is stored. Existing request and verification limits stay in effect.
- Delivery calls Meta's fixed HTTPS Graph endpoint with a bearer header. It sends the code in both the authentication body parameter and copy-code button parameter. Redirects are refused. No patient name, diagnosis, document or prescription content is sent.
- The request, including response parsing, has a ten-second timeout. A successful HTTP response must contain a WhatsApp message ID. This confirms acceptance by Meta, **not** receipt by the patient.
- Sends are synchronous and attempted once. OTPs are not persisted in queue payloads. There is no automatic retry because a timeout can happen after Meta accepts a message; blindly retrying could duplicate it.
- On rejection, timeout, network failure or malformed acceptance, the challenge is retired, the API returns 503 `UNAVAILABLE`, and the audit log records `auth.otp.delivery_failed` with organisation/challenge IDs and a safe failure stage (`provider` or `receipt`). Numeric Meta rejection codes and HTTP status are included when available; raw provider text is discarded. Failed requests still count against three codes per number per ten minutes. A delayed code from that failed request cannot sign in.
- Raw provider response bodies, tokens, phone numbers and OTP values are not included in public errors or failure logs. Validated numeric provider error codes are retained in restricted diagnostics. Check configuration and Meta's account/template health using its dashboard, without copying patient data into tickets.
- Signed status callbacks, durable background receipt processing and the clinic-admin delivery log are implemented (see below). Separate opted-in notifications and the clinic inbox are documented in their own runbooks; enabling OTP does not activate them.

## Staging acceptance

With a consented test recipient (never a real patient for development), select the clinic, request a code from the portal and confirm it arrives on WhatsApp from the expected sender. Enter it, confirm sign-in and confirm reuse is rejected. Check the code expiry and that the template's button copies the same six digits.

In staging only, revoke the test token or use an unapproved template and confirm the API returns a safe 503, no session is created and the failed challenge is retired. Restore the configuration. A successful unit suite does not replace this real provider acceptance test.


## Delivery-status callbacks and workers

Apply database migrations before deploying the API or workers. Migration `20261104130000_whatsapp_delivery` adds two metadata-only tables and a restricted `dhc_messaging` role; it does not change existing clinical records.

To enable callbacks, set these on the API in addition to its sending configuration:

```dotenv
WHATSAPP_WEBHOOK_ENABLED=true
WHATSAPP_APP_SECRET=<meta-app-secret>
WHATSAPP_WEBHOOK_VERIFY_TOKEN=<random-token-at-least-32-characters>
WHATSAPP_BUSINESS_ACCOUNT_ID=<numeric-whatsapp-business-account-id>
```

The app secret is not the bearer access token. Set the callback URL in Meta to `https://<api-host>/v1/webhooks/whatsapp`, use the same verification token and subscribe the WhatsApp account to the `messages` field. Verification returns the numeric challenge only on a token match. The verification route suppresses request logging because Meta includes the token in its URL. Keep callbacks disabled until these values are available; development and builds work without them.

Every POST is limited to 256 KB, verified using HMAC-SHA256 over the exact raw bytes, and checked against the configured business account and sending phone-number ID. Only sent/delivered/read/failed receipts for a known outgoing message are accepted for storage. Unknown messages, other accounts/senders, inbound chat text and unrelated status kinds are acknowledged without being stored. The optional conversational clinic inbox uses separate configured channels and is not activated by this OTP setup. The server adds a random internal delivery ID as `biz_opaque_callback_data` when sending; this permits a callback that races the send response to be correlated safely. No recipient number or organisation supplied by the callback determines tenancy.

On a storage failure the API returns 503 so Meta can retry. On success it returns 200 after the sanitized receipts commit to PostgreSQL, without waiting for Redis or processing. Raw bodies, OTPs, recipient IDs and provider error descriptions are discarded. The saved failure code is numeric only.

Run the workers with both `DATABASE_URL` and `REDIS_URL`. Every ten seconds a dispatcher leases up to 100 pending receipt IDs from PostgreSQL and adds `whatsapp-status` jobs to the `webhooks` BullMQ queue. A 60-second lease recovers a crash or Redis outage without losing saved receipts. Job payloads contain only event IDs. Processing and the `messaging.status_updated` audit insert commit together. Duplicate callbacks and duplicate jobs have no repeated effect. Read/delivered never regress to sent/failed; stale failures cannot overwrite a later sent status. Stronger delivered/read evidence can supersede a failure. The send request itself is still attempted only once.

Workers started without `DATABASE_URL` do not register receipt processing. In that state, or during a Redis outage, saved receipts remain pending and the admin log may stay at Accepted. Confirm workers are healthy before relying on delivery statuses.

## Admin log and recovery

Clinic admins open **WhatsApp delivery** at `/clinic/delivery-log`. The list is organisation-scoped and shows request time, status, last status time and numeric failure code. It deliberately shows no patient phone, OTP, challenge ID or provider message ID. **Refresh** reloads the first page; **Load more** pages through older entries. Accepted means Meta accepted the request, not that a patient received it. The API is `GET /v1/delivery-log?limit=50&status=failed` (optional status and cursor); doctors, front desk and patients cannot access it.

Submission diagnostics require migration `20261110090000_otp_submission_diagnostics` before the new API image. The migration retains the old two-argument failure function for older images. Rejected OTP submissions can now show Meta's numeric error code in the admin delivery log. The failure audit distinguishes the provider call from recording its acceptance. Response parsing is limited to 16 KiB. Network failures, timeouts and invalid/oversized error bodies may have no code; a blank code does not prove Meta rejected or accepted the message. Historical failures cannot be reconstructed from these diagnostics. Successful delivery callbacks still take precedence over submission-failure recording.

Use the numeric code to investigate the corresponding Meta account or template setting. Never copy raw responses, tokens or OTPs into tickets, and never automatically resend a failed request. A further live test requires an explicitly authorized recipient and send.

For a backlog, check the worker's database and Redis connections and the platform console's **webhooks** queue counts. A job retries five times with exponential backoff. Final failures remain in BullMQ for investigation; after fixing the cause, retry the existing failed job through the queue's operational tooling. The inbox remains unprocessed until the job succeeds; rotating leases prevent failed jobs from blocking later receipts. Do not delete pending inbox rows to clear the backlog. No automatic receipt-retention purge is included yet.


Appointment confirmations/reminders now have a separate opt-in and outbox; see [appointment messaging](whatsapp-appointments.md). OTP sign-in remains independent of appointment preferences.

### Profile number-verification codes (ADR 0027)

The same approved authentication transport also delivers purpose-bound `phone_change` codes to the old and proposed numbers. Confirm the approved template is suitable for this verification flow during real-provider acceptance. The sign-in verifier rejects these challenges. Preparation is claimed before sending; a request retry never automatically issues another pair. Delivery failure leaves an incomplete request, with no authorized transfer; the patient may explicitly start another request within the per-phone/account limits. Never log, manually retrieve or ask a patient to share OTPs. A lost old number is an in-person clinic verification case, not a transport override.
