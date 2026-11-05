# WhatsApp inbox activation and recovery

Related: ADR 0030; existing WhatsApp OTP/appointment/record/payment runbooks.

## Configure later

1. Use a clinic-owned Meta phone-number ID for each participating clinic. Do not infer a clinic from an incoming phone number and do not share an inbox sender between clinics. Inbox numbers must also differ from the global shared OTP/automated-notification number; reusing that number would make incoming clinic intent ambiguous. Use a fresh dedicated clinic number, not a historically shared number. Keep the feature disabled until mappings and access are configured.
2. Set `WHATSAPP_INBOX_ENABLED=true` and a JSON array in `WHATSAPP_INBOX_CHANNELS_JSON`: `[{"organisationId":"<clinic UUID>","senderId":"<Meta phone-number ID>","businessId":"<WABA ID>"}]`. The clinic and sender must each be unique. First use pins the mapping in the database; moving a number needs an explicit reviewed migration. Do not delete/recreate bindings to bypass this.
3. Configure `WHATSAPP_WEBHOOK_ENABLED`, the existing app secret/verification token, Graph version, access token and legacy sender/WABA settings. Inbox channels use the same Meta app secret and access token; it must have message-send and business/template-read permissions for the configured assets. Secrets stay in the environment, never admin forms or message rows.
4. Subscribe the Meta app's verified webhook to message events for the inbox numbers. Verify signatures and test wrong-app/WABA/sender refusal. Confirm an actual incoming India-number message reaches exactly one clinic and duplicates remain one message.
5. In Meta WhatsApp Manager, prepare an approved utility template with a static text BODY only. In the web app, an admin synchronizes and enables it. Changed bodies/statuses require fresh review and enablement. Synchronize at least hourly before template sends. There is no local approval override.
6. Record explicit service-template agreement before proactive service replies. Verify STOP, clinic account closure, team handoff and stale-window blocking with synthetic clinic participants. Do not use real medical information during acceptance.

## Delivery recovery

A browser failure does not prove that Meta did not accept the message. Use **Recover same reply** and the existing intent ID; do not create a new UUID to retry an unknown result. `accepted` is not proof of delivery. Refresh for signed sent/delivered/read receipts. `uncertain` is deliberately not retried by the dispatcher. Reconcile it using Meta status/support information before a human decides whether a new send is appropriate.

The API's periodic inbox sweep picks up `queued` rows and marks abandoned `sending` rows uncertain after one minute. If the process restarts, already-authorized messages never return to queued. Unknown/configuration failures leave durable rows for review. A later STOP cannot recall a network request already authorized; pending unclaimed replies are skipped.

If templates fail to synchronize, the existing catalog is unchanged and old entries expire from sending eligibility after one hour. Inspect provider configuration/scopes without copying tokens, patient texts or phone numbers into logs/tickets. Provider error codes are safe to report; raw response bodies are not. Template cost reporting, clinical record delivery and automated notice settings follow their separate workflows.

Doctor-owned threads cannot be taken back by front desk/admin through ordinary reassignment. Handle an unavailable or offboarded doctor through a reviewed clinic access process; an emergency access override is not implemented. Inbox content is not an emergency-monitoring service and does not grant access to patient charts.
