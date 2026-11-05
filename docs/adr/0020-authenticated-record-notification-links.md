# ADR 0020: Generic WhatsApp record notices and authenticated navigation

- Status: Accepted
- Date: 2026-11-04

## Decision

Use a separate `records` consent category for new signed prescriptions, signed referral letters and shared patient documents. Appointment consent never authorizes these messages. The scope is the organisation, direct patient phone, sender and category. No guardian-phone fallback or backfill. STOP revokes both optional categories; OTPs remain separate.

Database triggers create durable intents in the source transaction. Each record/sender is unique. Workers lease IDs, recheck source eligibility, current phone, organisation and consent version, and authorize one HTTP submission. Queued superseded/void prescriptions and withdrawn documents are skipped. Expiry is 24 hours; ambiguous sends are marked uncertain and are not sent again. External HTTP runs after the transaction; revocation or withdrawal after authorization can race an in-flight message, but file access is checked again.

An approved generic template has one body parameter: a public HTTPS navigation URL. No record title, type, patient name, clinical text or source ID goes into its message parameters. A domain-separated HMAC-SHA256 token covers a delivery UUID and expiry (one hour from authorization). API and workers use the same separate random secret, at least 32 characters, through `@dhc/secure-links`; rotating it invalidates old links. The delivery UUID is a correlation identifier, not a source record identifier.

Links grant no authorization. The resolver requires patient authentication, current health/account consents, tenant isolation, family-history ownership and current source validity. Every file endpoint repeats authorization. A forwarded link cannot expose another family's record. Signed referral letters remain valid after referral closure. Patients gain a letter list and audited, hash-verified PDF route.

Web links preserve their destination through existing login and onboarding. They use no-store and no-referrer headers. Resolver request logging is disabled. Object URLs and file tabs use the existing session registry and close on logout.

## Consequences

Sending is off by default. Operators must configure callbacks/STOP handling, approved templates, the common secret, public HTTPS origin and Redis workers before a controlled live test. Expired links lead people back to portal records. This slice covers web navigation; native mobile deep links, proactive cancellation messages, attachments and campaigns are outside scope. Existing server signing-provider production requirements still apply.
