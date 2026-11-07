# Cashfree setup, collection checks and recovery

Owner: Backend lead (technical), clinic admin (business follow-up).

## Implemented scope

Online collection for an existing bill is implemented and disabled by default. This includes a manually shared payment link, hosted web checkout, verified payment callbacks/status checks, numbered receipts and collection reports. Refunds, read-only settlement reconciliation and prepaid in-person web booking are also implemented behind independent disabled flags; native checkout and live provider acceptance remain pending. Audio/video web checkout is covered by ADR 0037.

## Configure later

1. Apply migrations and deploy matching API/web builds. Runtime database login must be permitted to `SET ROLE dhc_payments`, as for existing application/auth roles. Only the internal role writes the new payment tables; RLS still scopes it to an organisation.
2. Each clinic completes its own Cashfree merchant account/KYC. Populate `CASHFREE_MERCHANTS_JSON` in the server secret store, keyed by organisation UUID, with `clientId`, `clientSecret`, and `environment` (`sandbox` or `production`). Accounts must be distinct per clinic/environment; never substitute the platform account or commit credentials. The adapter pins API version `2026-01-01`.
3. Set a separate random `CASHFREE_LINK_SECRET` of at least 32 characters, `CASHFREE_WEBHOOK_URL=https://<api>/v1/webhooks/cashfree`, and public HTTPS `WEB_BASE_URL`. Whitelist the web domain in Cashfree. Use INR without provider offers/DCC that change the collected amount; a changed amount/currency is held for review by this increment. The API requires its existing field-encryption key; use stable secrets and original merchant bindings while orders are outstanding.
4. Configure Cashfree payment-success, failed and user-dropped webhooks using the matching version. Set `CASHFREE_ENABLED=true` only for a controlled sandbox pilot. Callbacks use the Cashfree PG secret key; the signature is over timestamp plus exact raw request body. Configure proxies to preserve it and avoid logging payment-link tokens, raw payloads or credentials.
5. Pilot one consenting test recipient: partial counter payment followed by balance collection, success/failure/drop, delayed callback, callback retry, return without callback followed by server check, invalid signature, close while a transaction is pending, and provider-confirmed closure before counter collection. Verify exactly one receipt, correct organisation/amount/currency, and correct collection total. Automated tests make no real gateway payments.

## Staff workflow

Front desk/doctor saves a bill, then chooses **Create payment link**. Share it manually with the intended payer. No amount comes from the browser: it is the saved remaining balance. The page reveals only clinic label and amount/state. The payer enters payment information on Cashfree. Checkout lasts 30 minutes; status remains available for 24 hours afterwards. The receipt remains available through the normal staff billing view.

An open payment reserves the bill. Do not edit it or collect again at the counter. **Check payment status** fetches the original provider order and successful transaction; it applies credit only after matching order, amount, currency and source binding. **Close payment link** requests termination and checks the result; `closing` is still locked. Local expiry is not proof of failure. Cashfree must confirm expiry/termination and no successful/pending transaction before another collection is allowed. Closing never initiates a refund.

## Patient says “I paid but the bill is unpaid”

1. Use the bill's **Check payment status** control. Browser success/screenshots are not authoritative.
2. Inspect the normal receipt and audit events (`payment.online_created`, `payment.online_confirmed`, `payment.online_review`, `payment.online_checked`). Callback metadata is in `cashfree_events`; no raw customer/card/bank payload is retained.
3. If provider status confirms one matching successful transaction, the API applies its numbered receipt atomically. A duplicate callback/check cannot apply it again.
4. If any amount/currency/order/account differs, or another successful transaction exists, pause collection and investigate. Never collect again or manually forge a Cashfree counter entry. There is no automatic refund/resolution tool yet; handle provider-side investigation through the clinic's authorized merchant process and retain an audit trail. Additional successful transactions are exposed by the staff review indicator, even after the first receipt was confirmed.

## Outage, ambiguous creation or configuration change

Creation reserves a deterministic order/idempotency key before HTTP. A lost response leaves `creating`. Retry the original action: it reuses the stored intent and fetches the existing provider order. Do not create a replacement order, clear the reservation or take cash just because a request failed. Original request details are encrypted snapshots, so retries do not silently change recipient or amount. Fix configuration/provider availability and retry. Definitive creation rejection is conservatively kept reserved until recovery/check/closure; there is no unsafe “discard unknown order” button.

Keep the original merchant ID/environment and keys available for pending orders. Switching an organisation's merchant identity prevents checking those orders until the original binding is restored. Changing the field-encryption key without migration loses encrypted request/session recovery. Rotating the link secret invalidates outstanding links (including provider return URLs); staff status checks remain the recovery route.

## Pause safely

Set `CASHFREE_ACCEPT_NEW_PAYMENTS=false` to stop new links and checkout. Leave `CASHFREE_ENABLED=true`, credentials and callbacks available until all in-flight orders are reconciled or closed. Turning the global flag off makes callbacks return unavailable for provider retry and must not be used to pause an active merchant casually. Nothing can recall a checkout session already handed to the provider; a later verified payment is still recorded.

## Next increments

Refunds, scheduled settlement reconciliation and prepaid in-person web booking now have their own sections below. Native checkout and live provider acceptance remain pending. See [ADR 0021](../adr/0021-cashfree-existing-bill-collection.md) for official provider references and current boundaries.

## Refund implementation update — 2026-11-04

Refunds are now implemented (ADR 0022). Read-only settlement reporting and acknowledgement are described below. Acknowledgement does not automatically resolve a payment/refund review flag.

Keep `CASHFREE_REFUNDS_ENABLED=false` until a controlled sandbox refund pilot passes. It requires the existing enabled Cashfree integration and original merchant bindings; it is independent of `CASHFREE_ACCEPT_NEW_PAYMENTS`. Configure the same signed callback endpoint for `REFUND_STATUS_WEBHOOK`. Refund reads/checks/callbacks remain active when the new-refund flag is false, provided the global integration remains enabled.

A clinic admin opens a paid bill's Refunds card, chooses the original Cashfree receipt, amount and reason code, and confirms the exact request. Requests reserve refundable funds before HTTP. Do not replace a request after an unknown response: **Recover original request** uses its original UUID/refund ID/idempotency key. **Check refund status** only reads provider state; it never creates money movement. Verified CANCELLED/REJECTED releases capacity. PENDING, PENDING_APPROVAL, ONHOLD and uncertain requests keep it reserved; unsupported failure states require review.

**Check provider refunds** imports verified merchant-dashboard refunds for the original credited transaction. Creation also does this check before allowing another request. A refund for another payment on the same order, identity/amount/currency mismatch or excessive confirmed total flags review; do not attribute it to this receipt or issue a replacement. Review flags are deliberately not cleared automatically in this increment. Investigate in the original merchant account and retain an audit trail; settlement-report acknowledgement also leaves those source flags unchanged.

Only confirmed refunds produce an RF voucher and a ledger entry. Gross paid balance and the original receipt do not change, and no new collection is opened. Collections show receipts posted, refunds posted and net total, including negative days. Imported historic refunds post on verification day; compare original provider dates when reconciling settlements.

Pilot partial refund, full remaining refund, repeated requests/callbacks, lost accepted response, read-only check followed by explicit recovery, cancellation/rejection, stale pending callback after success, mismatched data, external dashboard refund import, voucher/receipt checks and refund-only reporting. Automated tests use synthetic funds and do not replace a genuine sandbox pilot. Cashfree's provider-side eligibility window still applies. No real refund is made as part of development.


## Settlement reports and review (ADR 0023)

Set `CASHFREE_RECONCILIATION_ENABLED=true` on **both API and workers**, with `DATABASE_URL`, Redis, and the same `CASHFREE_MERCHANTS_JSON` clinic accounts. Keep the API's `CASHFREE_ENABLED=true` and its existing configuration. Workers need no payment link secret. This flag is independent of accepting new payments and of enabling new refunds. Keep all flags disabled until deployment credentials and sandbox checks are ready.

After 01:00 IST each day, the worker queues one report per configured clinic/account, covering the previous seven completed IST days. `CASHFREE_RECONCILIATION_LOOKBACK_DAYS` accepts 1–31. The rolling window is not an assertion that all settlements arrive within seven days: choose longer coverage and use manual historical windows to cover outages, delayed settlements, older imports or account changes. Scheduling resumes on the next worker tick; it does not backfill every missed day automatically.

Clinic admins open **Settlement reconciliation**, select 1–31 completed IST days, and request a report. Requests persist before queue publication. Every provider page is read before a snapshot is published. Gross payments, fees, tax, adjustments, net, provider status and UTR remain separate. Provider/customer/bank payloads and free-text notes are not retained. Empty completed reports are possible; failed/incomplete reports never show a partial match.

A database dispatch lease recovers Redis outages. Processing renews a fenced lease per report page, retries failures with backoff up to five attempts, and rejects stale workers. After the last failure, request a fresh report. A crash on the final attempt becomes failed when its lease expires. Existing completed snapshots are immutable; rerunning creates a new snapshot. Pausing this feature stops dispatch/processing; existing reports stay readable.

Review items link to the bill when the source is known. Use its existing **Check payment** or **Check provider refunds** actions to verify missing records with the original account, then request a fresh report. Unknown transactions, ambiguous refund IDs, adjustments/disputes, unsupported charging basis and amount/account/identity conflicts require investigation in Cashfree. Never create a replacement payment/refund just to make a report match. A clinic receipt/voucher posted within a period can be absent from that provider period because posting and provider event dates differ. Report acknowledgement records a reason and audit entry; it changes no ledger, receipt, bill, source review flag or mismatch count.

Cashfree's reported settlement status and UTR do not prove that your bank statement contains the credit. Match UTR and net amount against the bank statement before confirming bank receipt. This increment has no bank-feed import, dispute resolution or automatic financial correction.

Before enabling: run a sandbox collection and partial refund, wait for reporting availability, test more than one report page, compare gross/fees/tax/adjustments/net and UTR with the merchant dashboard, verify a deliberately unmatched transaction appears, and confirm that acknowledging it changes no balance. None of these live-provider checks has been performed without credentials.

## Prepaid web bookings (ADRs 0024 and 0037)

Set `CASHFREE_PREPAID_BOOKING_ENABLED=true` on the API only after sandbox verification; it defaults false. Keep `CASHFREE_ENABLED=true`, the original clinic account and callbacks available for existing reservations. No extra provider credentials or worker queue is needed. Configure an active in-person consultation type, or a clinic-enabled audio/video type with a verified doctor, with **Paid at booking**, a standard fee of ₹1–₹1,00,000, and a schedule. The web portal opts into supported prepaid options. Older mobile clients continue seeing the existing pay-at-clinic options; native checkout remains pending.

The patient reserves a slot before opening checkout. The server snapshots the fee and clinic approval policy and creates a pending reservation, bill and original order atomically. Checkout lasts 30 minutes, and the selected slot must be at least 35 minutes away and pass the ordinary clinic cutoff. An unknown provider response keeps the reservation discoverable in **Appointments**; retry/check that same reservation, never create a replacement payment. Dependants pay through their number holder's account.

A verified receipt confirms the appointment automatically only when the captured clinic policy allows it. Otherwise payment is recorded and the appointment waits for clinic approval. Staff cannot confirm/check in an unpaid hold. A patient may explicitly close an unpaid reservation; if payment already succeeded, the verified payment wins and cancellation/refund must be handled normally.

Each API instance sweeps due reservations every 30 seconds, using a shared database lease so only one instance claims each hold. Uncertain/closing/missing orders stay reserved and retry, including after process restart. Release occurs only after verified terminal provider closure and payment-attempt checks. There is no claim that local expiry alone cancels a provider payment. Keep the API running and monitor recurring sweep-unavailable logs and held/review states.

Late success after release or after the slot starts records the receipt and requires clinic review; it never restores the appointment. Open the bill to see the reservation state, inspect the receipt/provider account, and use the explicit admin refund flow if needed. Audit actions use `booking.prepaid_*`. Unpaid holds are excluded from automatic no-show penalties. Cancelled/closed quote bills remain frozen historical records and cannot be collected through a replacement order/counter payment.

Prepaid bookings cannot be rescheduled here. Cancel the existing appointment, review/refund its payment when appropriate, then create a new booking. Automatic refunds and native checkout are not included. Audio/video bookings use the same reservation flow, with independent clinic enablement, verified doctor and online consent/identity requirements. Before enabling, test real sandbox paid/failed/abandoned checkout, return without callback, callback without return, asynchronous cancellation, delayed success and a partial/full refund.
