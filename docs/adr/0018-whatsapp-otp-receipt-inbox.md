# ADR 0018 — Meta WhatsApp OTP receipts through a durable sanitized inbox

Date: 4 November 2026

## Context

The owner selected Meta WhatsApp Cloud API directly and WhatsApp-only delivery for now. OTP requests must not put plaintext codes into a background queue. Meta acceptance does not establish delivery; receipts can race the send response, be duplicated, or arrive out of order. A callback also has no signed-in organisation context. Redis downtime must not lose receipts or force the API to wait for a worker.

## Decision

Keep OTP submission synchronous, bounded to ten seconds, with one send attempt. Create an internal delivery row before sending and supply its random UUID as Meta's opaque callback data. Store the provider message ID on acceptance. A callback can correlate before that acceptance write, but only against an existing row and its sender. A stored message ID can never be rebound to a different provider message by the functions.

Enable callbacks explicitly. Verify the exact raw request bytes with the Meta app secret, then check the configured WhatsApp account and sending phone-number ID. No organisation or recipient supplied by the callback determines tenancy. Ignore unrelated messages and unsupported event kinds. Save only sanitized status metadata and numeric failure codes, never the raw callback, recipient phone, OTP or provider error descriptions. The verification GET route suppresses request logging to protect its URL token.

Commit receipts to PostgreSQL before acknowledging Meta. Unique (delivery, status, occurred-at) keys suppress duplicate events. The API does not require Redis. Workers claim batches with a 60-second lease, publish IDs only to BullMQ's `webhooks` queue and process them transactionally. Leases recover crashes and publish outages; failed jobs retry five times and remain inspectable. Queue publication uses bounded Redis commands. Processing and its status audit event commit together.

Dedicated SECURITY DEFINER functions with fixed search paths separate capabilities. `dhc_auth` may create/accept/fail deliveries from existing OTP challenges; `dhc_messaging` may receive/claim/process sanitized receipts but has no direct table or clinical-data grants. `dhc_app` gets SELECT only on delivery rows under organisation RLS. Only clinic admins may read the delivery API/page; no patient identity, challenge ID or provider ID is returned.

Read and delivered evidence never regress to sent or failed. An older failure cannot overwrite a later sent event. Stronger successful evidence may supersede a failure regardless of callback arrival order. Every stored event is marked processed even if its transition is stale or redundant.

## Consequences

Status updates can lag while workers or Redis are offline. Already accepted sends are not retried automatically, because timeouts can occur after Meta accepted a request. A failed request retires the OTP even if a delayed receipt later confirms delivery. Inbox/chat text, notifications, SMS fallback, document/referral sends, per-organisation sending accounts and automatic receipt retention are separate increments. Configuration and real Meta acceptance can be completed later; synthetic tests do not send external messages.

Validation includes the actual migration on PostgreSQL 16, signature and raw-parser tests, duplicate/out-of-order/early callback cases, tenant and database-role isolation, crash-lease recovery, worker payload boundaries, and a browser test for the admin log and refresh.
