# Optional review requests

## Activate after deployment

1. In Google Business Profile, copy the direct review link. Supported formats are
   `https://g.page/r/PLACE/review` and
   `https://search.google.com/local/writereview?placeid=PLACE_ID`.
   Use the clinic's actual listing; arbitrary redirect URLs are rejected.
2. Create an approved Meta marketing template with exactly two body text parameters:
   clinic name first and invitation URL second. For example: “Thank you for visiting
   {{1}}. You may leave an honest Google review here: {{2}}. This is optional and does
   not affect your care. Reply STOP to stop optional messages.” Meta controls approval
   and category. No discounts, gifts, star requests or positive-feedback filtering.
3. Configure the API and worker with `WHATSAPP_REVIEWS_ENABLED=true` and the same
   strong `WHATSAPP_REVIEW_LINK_SECRET` (at least 32 non-whitespace characters).
   Workers also need `WHATSAPP_REVIEW_TEMPLATE` and
   `WHATSAPP_REVIEW_TEMPLATE_LANGUAGE` matching the approval exactly.
4. Supply the existing Meta access token, phone-number ID and Graph API version;
   workers require a working database, Redis and public HTTPS `WEB_BASE_URL`.
   Enable `WHATSAPP_WEBHOOK_ENABLED` with the app secret, verify token and business
   account ID. Subscribe to message/status callbacks using the existing
   [Meta setup guide](whatsapp-cloud-api-setup.md). Check STOP handling before activation.
5. Apply migrations, deploy API/web/workers, then open **Clinic → Review requests** as
   clinic admin. Save the direct Google URL, enable invitations and choose the cooldown.
   Patients independently allow invitations from **Review invitations** in their portal.

The Compose environment examples include these fields with reviews disabled by default.
Never put real access tokens or link secrets in Git. Changing the link secret invalidates
existing invitations. Saving clinic settings also invalidates previous invitations.

## Staff workflow

Choose a visit date, load completed visits and select the intended visit. The recipient
must have opted in; the visit must be in the past 30 days and outside the recipient's
cooldown. Family records sharing the number share a cooldown. Failed/cancelled requests
also consume it. Request once and use the retained retry action after an unknown response.

Refresh tracking to see current provider states. Accepted is not delivered, and opened is
not a posted review. Patients see a neutral page and explicitly continue to Google.
The service does not read their rating or review. No real provider message is sent by
the automated local tests.

## Recovery and withdrawal

- Cancel to invalidate an invitation and skip a queued send. An already authorized
  provider request may still finish; cancellation cannot unsend WhatsApp messages.
- Unknown sends remain uncertain. Check the delivery log and signed callback history;
  do not manually repeat them to force delivery.
- Unsent queue entries expire after 24 hours. Public invitations expire after 14 days.
- A patient's withdrawal or STOP blocks future authorization and existing links.
  Closed/disabled accounts, changed contacts, cancelled visits and changed settings
  also prevent use when checked. Patients can withdraw without health-data consent.
- Disable the clinic setting to stop authorizing new sends and invalidate its links.
  Disabling the deployment switch stops dispatch; also disable the clinic setting when
  retiring existing invitations.

Before enabling for a real clinic, verify one expressly consented test recipient, real
Meta acceptance/delivery callbacks, explicit link opening, STOP and cancellation. Confirm
the public hostname and Google destination. Retain provider activation as a separate
acceptance item; local synthetic tests are not evidence of live delivery.
