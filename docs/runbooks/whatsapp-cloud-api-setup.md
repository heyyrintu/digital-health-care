# Configure WhatsApp patient login on the hosted web app

Site: `https://dhc.drsiddharthguptaortho.in`. This guide enables **patient OTP login first**, using Meta WhatsApp Cloud API directly. It does not activate appointment notices, billing notices, record notices or the conversational clinic inbox.

The sender must be registered with the WhatsApp Business Platform/Cloud API. Having a working SIM or ordinary WhatsApp account alone does not provide API access. If the number is already used by a WhatsApp app, follow Meta's supported onboarding/coexistence/migration flow; do not delete an existing account as a shortcut.

**Important for this repository:** `docker-compose.coolify.yml` currently fixes `OTP_DELIVERY` to `disabled` in its shared preview settings. Merely adding credentials in Coolify does not enable OTP. Section 4 shows the API-only Compose references needed. The snippets are configuration instructions, not changes already activated on your server.

## 1. Confirm the Meta account and sending number

In Meta Business Settings and the Meta developer app associated with this WhatsApp account:

1. Select the correct business portfolio, app and WhatsApp Business Account (WABA).
2. Confirm the intended number is registered/connected for Cloud API and usable for sending. Complete verification, display-name, billing or production-access steps shown for your account.
3. Open the app's WhatsApp API setup/configuration area and record the numeric **Phone number ID** and **WhatsApp Business Account ID**. These are separate IDs; neither is the displayed phone number or business portfolio ID.
4. Record a Graph API version supported by that app. Use the version shown in Meta's current API example/settings. Do not copy the synthetic `v23.0` used in this repository's tests as a live-version recommendation.

Meta's UI labels may vary. The required values and template shape below are the stable application contract. See [Meta's Cloud API collection](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api).

## 2. Create the authentication template

In **WhatsApp Manager → Message templates → Create template** (or the equivalent template editor for the selected WABA), use:

| Setting                               | Value for this app                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------ |
| Category                              | **Authentication**                                                             |
| Template name                         | **`patient_sign_in`**                                                          |
| Language                              | **English (US)**, if offered; record its exact approved code, normally `en_US` |
| Code delivery/button                  | **Copy code**                                                                  |
| Security recommendation               | Enable the warning about keeping the code private                              |
| Expiration notice                     | **5 minutes**                                                                  |
| Delivery-validity setting, if offered | No longer than 5 minutes                                                       |

Use Meta's preset authentication content. Do not add a custom marketing/utility message, clinical details, promotional text or a custom website-link button. Do not select one-tap/zero-tap autofill: the current web integration uses Copy code.

Submit the template and wait for **Approved** status in the same WABA as the sending number. Save the exact template name and language code; `en`, `en_US` and `en_GB` are different configurations. If you choose a different approved name/language, substitute it in the environment values below.

The app supplies the same six-digit code as the BODY parameter and the first copy-code button parameter. In the sending API that button parameter is represented as `sub_type: url`; **this does not mean you should create a normal URL-button template in WhatsApp Manager**. Meta's [Copy code authentication example](https://www.postman.com/meta/whatsapp-business-platform/request/6vkv46u/create-authentication-template-w-otp-copy-code-button) is the relevant template family.

If Meta refuses authentication-template creation, resolve the account's displayed eligibility/verification issue. Do not substitute a Utility or Marketing template to bypass authentication-template requirements. This approved template can also carry the app's number-verification codes; verify that flow during provider acceptance.

## 3. Create a deployment access token

In **Meta Business Settings → Users → System users**:

1. Create/select the system user for this deployment.
2. Assign the correct Meta app and WhatsApp account assets, with the access needed to send from the selected number.
3. Generate a token for that app with **`whatsapp_business_messaging`**. Add **`whatsapp_business_management`** when administering templates or managing the WABA/app subscription through the API.
4. Select an appropriate long-lived/non-expiring system-user option if available for the account. Such tokens can still be revoked; retain ownership and rotation procedures.
5. Save the token directly into Coolify's protected environment settings or your secret manager. Do not use the temporary token from the API testing screen for ongoing patient login.

The token must access the same WABA/phone ID used by the approved template. See Meta's [token and API documentation](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api?entity=request-13382743-41c3bdc1-703a-4322-99d5-f21273e01db9).

## 4. Configure Coolify and the API's Compose environment

Finish initial clinic/staff setup before activation. The empty-demo bootstrap command intentionally refuses to seed with OTP/providers enabled. Keep the current database, JWT secret and field-encryption key.

In the healthcare application's **Environment Variables**, enter:

```dotenv
OTP_DELIVERY=whatsapp
WHATSAPP_ACCESS_TOKEN=YOUR_SYSTEM_USER_TOKEN
WHATSAPP_PHONE_NUMBER_ID=YOUR_NUMERIC_PHONE_NUMBER_ID
WHATSAPP_GRAPH_API_VERSION=YOUR_SUPPORTED_GRAPH_VERSION
WHATSAPP_OTP_TEMPLATE_NAME=patient_sign_in
WHATSAPP_OTP_TEMPLATE_LANGUAGE=en_US
```

Replace all `YOUR_...` placeholders. The Graph value must have a form such as `vNN.0` with an actual supported version number replacing `NN`. The language/name must match the approved template, not merely the display language of your app.

In the source **`docker-compose.coolify.yml`**, add the following entries to **`services.api.environment`**, alongside its existing `<<: *app-env`, API port, CORS and other settings. Preserve those existing entries and the surrounding service definition:

```yaml
# Add only inside services.api.environment:
OTP_DELIVERY: ${OTP_DELIVERY:-disabled}
WHATSAPP_ACCESS_TOKEN: ${WHATSAPP_ACCESS_TOKEN:?Set the Meta system-user token}
WHATSAPP_PHONE_NUMBER_ID: ${WHATSAPP_PHONE_NUMBER_ID:?Set the Meta phone number ID}
WHATSAPP_GRAPH_API_VERSION: ${WHATSAPP_GRAPH_API_VERSION:?Set a supported Graph API version}
WHATSAPP_OTP_TEMPLATE_NAME: ${WHATSAPP_OTP_TEMPLATE_NAME:?Set the approved authentication template name}
WHATSAPP_OTP_TEMPLATE_LANGUAGE: ${WHATSAPP_OTP_TEMPLATE_LANGUAGE:?Set the approved template language}
```

These entries override the shared `disabled` value **for API only** and explicitly pass the credentials into its container. OTP sends happen in the API, not the workers or browser. Do not change the shared seed/migration settings to activate this feature, and never put the token into `NEXT_PUBLIC_*` variables or the web container.

Commit/push the Compose references to the deployment branch, reload the Compose definition in Coolify, confirm the values are saved, then deploy that revision. A plain restart does not inject changed container environment values. Missing required values will prevent deployment, so prepare them before deploying the edited Compose file.

Keep all appointment/operation/record/payment notices and `WHATSAPP_INBOX_ENABLED` false while testing login. The shared OTP sending number must not be reused as the separate conversational inbox channel.

## 5. Publish the patient consent documents

The production patient portal requires published privacy-notice and terms URLs before the initial consent screen can be completed. In Coolify, set:

```dotenv
PRIVACY_NOTICE_URL=YOUR_PUBLISHED_PRIVACY_NOTICE_URL
TERMS_URL=YOUR_PUBLISHED_TERMS_URL
```

The existing Compose web settings already reference these two values. Use working public URLs for the actual reviewed documents, not example URLs or an invented `/privacy` path that returns 404. This is a separate requirement from Meta template approval. Do not bypass the consent screen to demonstrate a patient login.

## 6. Optional but recommended: delivery receipts/webhook

OTP sending can work with webhook callbacks disabled. To see sent/delivered/read/failed statuses in the clinic-admin delivery log, configure the callback after the OTP configuration is ready.

Collect these additional values:

| Variable                        | Source                                                                                                    |
| ------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `WHATSAPP_BUSINESS_ACCOUNT_ID`  | Numeric WABA ID in Meta's WhatsApp API setup/account details                                              |
| `WHATSAPP_APP_SECRET`           | Secret for the Meta app, from its app settings; **not** the access token or your application's JWT secret |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | An independently generated random token of at least 32 characters; use the same value in Meta and Coolify |

Generate the verification token privately, for example on your laptop with Node:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Save it in your secret manager/Coolify, not a ticket or screenshot. Add those three values and `WHATSAPP_WEBHOOK_ENABLED=true` to Coolify. Add these additional entries to **the same API environment mapping** in Compose:

```yaml
WHATSAPP_WEBHOOK_ENABLED: ${WHATSAPP_WEBHOOK_ENABLED:-false}
WHATSAPP_APP_SECRET: ${WHATSAPP_APP_SECRET:?Set the Meta app secret}
WHATSAPP_WEBHOOK_VERIFY_TOKEN: ${WHATSAPP_WEBHOOK_VERIFY_TOKEN:?Set a random webhook verification token}
WHATSAPP_BUSINESS_ACCOUNT_ID: ${WHATSAPP_BUSINESS_ACCOUNT_ID:?Set the WhatsApp Business Account ID}
```

Deploy with these values **before** Meta attempts verification. Then, in the Meta app's WhatsApp webhook configuration, set:

```text
Callback URL:
https://dhc.drsiddharthguptaortho.in/v1/webhooks/whatsapp

Verify token:
The exact WHATSAPP_WEBHOOK_VERIFY_TOKEN saved in Coolify
```

Select Verify/Save and subscribe the **`messages`** field. Ensure the app is subscribed to the correct WABA, using Meta's account/app subscription setup (or its documented `subscribed_apps` API flow). Merely entering a callback URL does not establish that the intended WABA is subscribed.

The API checks webhook signatures using the Meta app secret and restricts receipts to the configured sender/WABA. Do not turn signature verification off. An ordinary browser visit to the callback without Meta's verification parameters is expected to be rejected; it is not the webhook test.

The existing workers already receive database/Redis connections and process stored receipts; they do not need the OTP bearer token for this step. Check their health. Clinic admins can inspect `/clinic/delivery-log`. Meta acceptance is distinct from delivery; a message can be accepted and later fail.

## 7. Run the first real-provider test

Use your own or another explicitly consenting test recipient's WhatsApp number, separate from the sending number. Current patient OTP transport accepts Indian **`+91` mobile numbers**. With Meta's test sender, the recipient must also satisfy Meta's test-recipient restrictions.

1. Confirm the API and workers are healthy after deployment.
2. Open `https://dhc.drsiddharthguptaortho.in/app/login?clinic=demo-clinic`, or substitute the actual configured clinic ID.
3. Enter the test recipient number and request a code once.
4. Confirm the expected business sender and approved template arrive. Use Copy code and enter the six digits on the website before the five-minute expiry.
5. Complete the actual consent screen and check patient portal access.
6. With callbacks enabled, check the clinic-admin delivery log for the receipt progression.

Do not paste OTPs, access tokens or app secrets into chat. The app limits code requests to **three per number per ten minutes**; do not repeatedly click resend while debugging. Failed/uncertain sends retire their challenge, so a delayed code from one of those requests will not sign in. There is no automatic SMS fallback.

## 8. Troubleshooting and rollback

| Symptom                                      | Check                                                                                                                                                                                                                                               |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI still says sending is unavailable         | Compose API container has `OTP_DELIVERY=whatsapp` and all five WhatsApp values; Coolify's saved variables alone do not override the fixed preview mapping. Deploy the updated mapping.                                                              |
| Meta rejects sending / app returns safe 503  | Token permission and asset assignment; registered phone ID; approved Authentication template in the same WABA; exact name/language; account billing/production restrictions. The app intentionally hides raw provider errors from public responses. |
| Template appears approved but fails          | Correct WABA/number pairing and language code, Copy code subtype and no extra custom parameters.                                                                                                                                                    |
| Meta webhook verification fails              | API callback flag/credentials deployed first, correct HTTPS URL and matching random verification token.                                                                                                                                             |
| Receipt stays at Accepted                    | Meta WABA subscription/messages field, app secret/WABA/phone pairing, healthy workers/Redis and pending receipt processing.                                                                                                                         |
| OTP works but portal consent cannot continue | In demo mode, the built-in `/privacy` and `/terms` pages are linked automatically after deploying the current web code. Live use requires reviewed clinic documents configured in `PRIVACY_NOTICE_URL` and `TERMS_URL`.                                                                                                                                                                         |
| Unknown clinic                               | Use the real configured clinic slug; finish the original clinic/staff bootstrap before activating providers.                                                                                                                                        |
| Code requests are rate-limited               | Wait for the limit window and check configuration before retrying. Keep rate limits enabled.                                                                                                                                                        |

To pause sign-in delivery after this mapping exists, set `OTP_DELIVERY=disabled` and redeploy. For callbacks, set `WHATSAPP_WEBHOOK_ENABLED=false` and redeploy. Keep the existing credentials stored until rotation/removal is planned. Compose passes optional values, and API configuration requires valid sender values whenever WhatsApp delivery is enabled. Do not change JWT/field-encryption keys, clear the database or expose environment dumps as troubleshooting steps.

For the send/receipt implementation details, see [WhatsApp OTP runbook](whatsapp-otp.md). Other templates and opt-ins remain separate: [appointments](whatsapp-appointments.md), [record notices](whatsapp-records.md), [payment notices](whatsapp-payments.md), [clinic inbox](whatsapp-inbox.md).
