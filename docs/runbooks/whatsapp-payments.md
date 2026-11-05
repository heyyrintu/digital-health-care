# Web payment/receipt availability notices

Implemented locally, disabled by default. Native development remains paused. See ADR 0025.

## Enable later, after sandbox acceptance

On API and workers set `WHATSAPP_PAYMENTS_ENABLED=true`; configure the same `WHATSAPP_PAYMENT_LINK_SECRET` (at least 32 random characters), existing Meta phone ID/access token/explicit Graph version, signed callback/STOP settings, HTTPS `WEB_BASE_URL`, database and Redis. Configure the worker's approved generic `WHATSAPP_PAYMENT_TEMPLATE` and `WHATSAPP_PAYMENT_TEMPLATE_LANGUAGE`. The template has exactly one body parameter, a secure portal URL, and no amount, diagnosis, patient name or attachment. Configure only a language approved for that template. Per-patient template language selection and full per-org sender administration remain future work.

The API flag requires callbacks so delivery receipts and STOP are available. Workers require all transport/template settings and HTTPS. No live send is part of automated tests. Dues collection separately requires Cashfree setup; counter-receipt notices do not require new Cashfree payments to be enabled.

## Consent and events

The number holder opts into **WhatsApp payment updates** in Privacy, or staff records their explicit agreement on the patient/guardian record. Existing appointment/record consent is insufficient. A dependant without their own number uses the current guardian's opted-in number. Grant payment consent before creating the order or posting the receipt/refund: historical events are not backfilled or resent.

First active order → payment availability; posted payment → receipt availability; posted refund entry → refund availability. New events queue durably inside their source transaction, even when Redis is unavailable. The admin delivery log shows the three event kinds and statuses. An accepted message is not proof of delivery, payment or bank receipt.

## Delivery and recovery

Worker dispatch runs every ten seconds. Before each send it verifies exact current consent, contact/guardian, tenant, organisation and source state. Stale/paid/closed/expired payment links are skipped. STOP/revocation skips queued notices. A notice already authorized/in flight cannot be recalled. If transport acceptance is uncertain, inspect the original Meta delivery/status rather than automatically sending again. This avoids duplicate messages and never initiates a replacement payment/refund.

A notice link needs patient sign-in to the intended clinic plus current family ownership and health-data consent. It expires after at most one hour; payment links also stop at the original checkout deadline. Expired/stale links can be replaced by opening **Payments and receipts** normally. Patient receipts are not exposed on the public pay-only page. Original receipts remain unchanged; refund updates are shown separately. Print/Save as PDF uses the browser's print dialog.

Pause new notices by disabling the feature on API/workers. Keep the API's financial link secret configured until already sent links expire. Existing receipts remain accessible from authenticated history. Retain the original Cashfree account/callbacks while payments are in flight; stopping notifications does not cancel an order.

## Acceptance before real use

With synthetic sandbox records, check separate opt-in, guardian delivery, active order notice, paid-before-dispatch suppression, receipt/refund notices, signed callback status, STOP, wrong-family/clinic denial, expiry, Redis recovery and uncertainty without resend. Check real template delivery in the selected language. Match provider payment/refund results and receipt amounts. No real Meta/Cashfree delivery is claimed by local test results.
