# ADR 0030: Clinic WhatsApp inbox and provider template catalog

Status: Implemented locally; provider and production acceptance outstanding
Date: 2026-11-05

## Decision

Add `/clinic/inbox` for incoming clinic service conversations and `/clinic/message-templates` for clinic-admin template administration. Use Meta WhatsApp Cloud API directly. Native work, SMS and AI stay paused/deferred. Credentials and live provider acceptance follow later; this increment sends no real messages during development.

### Routing and storage

`WHATSAPP_INBOX_ENABLED=false` by default. An operator supplies explicit unique clinic/sender/WABA mappings in `WHATSAPP_INBOX_CHANNELS_JSON`; each clinic has one inbox sender in this increment. Configuration refuses use of the shared OTP/automated-notification sender as an inbox number; a fresh dedicated clinic number is required. The existing Meta app secret verifies raw webhook signatures before any inbound work. Recipient phone numbers never choose a tenant. A sender is bound immutably to its clinic/WABA on first use; remapping fails closed rather than routing another clinic's messages. All configured WABAs must belong to the configured Meta app and access token.

Inbox tables use tenant RLS. Phone numbers and message/template bodies are field-encrypted; contact lookup uses a purpose-separated HMAC derived from the field encryption key. Only the last four phone digits remain readable for restricted metadata. Rotating field encryption/contact keys needs a planned migration, not an environment-only replacement. Message/template fingerprints use a separately derived keyed HMAC, so short encrypted replies cannot be guessed from plain content hashes. Provider IDs deduplicate incoming messages; retrying a webhook cannot duplicate a message or unread count. Thread/message identity and message contents are guarded against mutation/deletion.

This is an India-number, text-service inbox. Unsupported attachments/voice/media are represented by a placeholder; media IDs, URLs and captions are not retained or downloaded. No AI processing, automatic patient matching or clinical-chart linking occurs. A number can represent a family; staff must verify the person before discussing care. Mixed-family unverified conversations are not automatically included in a selected patient's portal export; reviewed access/retention requests need clinic handling. Production transcript/backup retention policy remains an operational requirement.

### Team permissions

Front desk reads/replies to the unassigned team queue. Clinic admins see masked conversation metadata and can assign an unassigned thread, but cannot read message bodies or reply. Doctors see only conversations assigned to them. Once a doctor owns a conversation, only that doctor may release or hand it over; admin/front-desk reassignment cannot bypass private content access. Inactive staff cannot authorize a send. This grants conversation access only, never chart access. Exceptional staff-offboarding handover needs a reviewed operational process; it is not an unrestricted admin override.

Read/unread, resolve/reopen, handoff and service-consent changes are revision-bound and audited using IDs/actions only. Read APIs audit content access. Queued sends are rechecked for assignment, membership, organisation status and current sender binding before authorization.

### Reply authorization and unknown outcomes

Free-text replies require a trusted incoming message within the 24-hour customer-service window, with a one-minute safety margin. The webhook cannot extend that window with future provider timestamps. Unsupported but valid incoming message types can open the window. The server checks the window both when accepting the intent and immediately before authorizing the network call. It never switches a late free-text reply to a template automatically.

Service templates require a separate explicit number-holder agreement recorded by authorised staff, with in-person/phone/written source. An inbound message alone does not grant proactive template consent. STOP blocks service replies, clears template consent and skips queued sends; a fresh explicit agreement is required to resume. Replays do not undo a newer agreement. Existing appointment/record/payment opt-ins remain separate and are not re-enabled by inbox consent. Signed STOP also reaches the existing sender-wide opt-out handler. Patient account closure stops the matching clinic inbox contact and pending sends; a future user-initiated service request still needs fresh recorded agreement before resumed outbound contact.

Every outgoing intent has a stable UUID and immutable encrypted content/input hash. The sender commits one `queued → sending` authorization under row locks, then makes a bounded provider call outside the transaction. At most four sends per API process run concurrently; per-thread and HTTP limits also apply. A process crash or indeterminate transport result becomes `uncertain`, never an automatic second send. The API sweep recovers queued intents and expires abandoned `sending` states without replaying them. A browser request interrupted after acceptance recovers the same intent UUID. Provider acceptance means accepted, not delivered; signed callbacks advance status monotonically, including callback-before-response. An already authorized or provider-accepted send cannot be recalled by a later STOP/handoff.

This durable API dispatcher is separate from the automated-notice BullMQ workers. It adds no patient text to Redis. The UI refreshes on demand; real-time push/polling is not supplied here.

### Template administration

Admins synchronize the authoritative Meta template catalog using bounded same-host cursor pagination, review the body/language/category/status and explicitly enable supported entries. New, changed, missing, paused/rejected or unsupported entries cannot silently remain sendable. Revisions prevent stale toggles. At dispatch, the template must remain approved/enabled/supported at the queued revision and synchronized within the last hour. A shared template lock coordinates revocation and send authorization. Meta remains the final authority on deliverability.

The inbox supports approved `UTILITY` templates containing one static BODY and no variables, headers, media, footers or buttons. Marketing/authentication/dynamic templates are displayed to admins but cannot be enabled for service replies. Template creation/editing and approval submission happen in Meta WhatsApp Manager, linked from the page; local enablement cannot invent provider approval. Existing automated appointment/record/payment/OTP template configuration remains separate. Dynamic notification bindings, provider-side authoring in this app, multiple inbox numbers per clinic, costing/billing dashboards and broader notification administration remain open work.

Protocol references: [Meta's official Cloud API collection](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api), [Meta's template-send example](https://www.postman.com/meta/whatsapp-business-platform/request/o65u5m5/send-message-template-text), [AWS provider guidance on the customer-service window](https://docs.aws.amazon.com/social-messaging/latest/userguide/managing-templates.html). No current provider pricing or legal retention duration is asserted here.

## Acceptance

Local integration tests exercise signed routing, tenant isolation, encrypted persistence, duplicate inputs, STOP, timing, private handoff, template restrictions, stale configuration, transport uncertainty, callbacks and account closure. Browser fixtures use a fake provider response and synthetic database rows; they must never call Meta. Real number registration/subscription, token scopes, approved templates, incoming media expectations, Redis coexistence, production storage/retention and a clinic pilot still require configured staging acceptance. No PR or deployment is part of this work.
