# ADR 0034: optional patient review requests

Status: implemented locally, 7 November 2026. Provider activation and hosted acceptance remain separate.

## Decision

Staff may request an honest Google review for a completed visit in the previous 30 days.
Clinic admins configure a direct Google Business Profile review URL and a 30–365 day
cooldown (90 by default). The cooldown covers all family records sharing one contact,
including failed and cancelled invitations. Requests are manual; there is no bulk campaign,
incentive, satisfaction survey, rating-based selection or automatic positive-review filter.

Patients opt in separately at `/app/reviews`. This optional preference is independent of
health-data consent, and withdrawal remains accessible without reaccepting care consent.
Consent must come from the current verified number holder with active clinic membership.
Current contact, guardian, account, source visit, settings revision and preference version
are rechecked before sending and when using a link. STOP withdraws optional messaging.

Requests and deliveries are created atomically under recipient serialization. A stable
request ID recovers interrupted responses without sending again. Queued requests expire
after 24 hours; invitations expire after 14 days. The durable worker authorizes one send.
Unknown provider outcomes are uncertain and never automatically resent. Stronger early
provider callbacks survive a later HTTP response. Cancellation blocks queued delivery and
the invitation, but cannot retract a message already authorized for sending.

The approved Meta template carries only clinic name and an opaque review URL. A
purpose-separated signed token stays in the URL fragment and is sent in POST bodies.
Resolution displays the clinic without counting a click. Only an explicit Continue action
records `openedAt` once and returns an allowlisted HTTPS Google review destination.
Pages are not indexed and use no-referrer metadata; API responses are private/no-store.
No patient name, clinical content, stars or review text goes to the public page.

Tracking distinguishes queued, accepted, sent, delivered/read, failed and uncertain states.
Link opened means a deliberate Continue action; it does not prove a review was posted.
Settings changes invalidate old links. Tenant RLS, fixed-history guards, audit events and
owned patient data-export inclusion apply. Platform operators gain no patient access.

## Scope and acceptance

Feature switches default off. See [activation and recovery](../runbooks/review-requests.md).
Local tests use synthetic records and fake provider responses; they do not prove Meta
template approval, real delivery, clinic ownership of a Google listing or hosted acceptance.

Validation: 54 migrations applied; all 15 review integration cases and 35 affected
data-rights/WhatsApp/tenant-isolation regression cases passed. All 31 scoped lint,
typecheck and unit-test tasks passed (619 unit tests). Ten mobile/desktop browser checks
passed across reviews, assessments, People and patient profiles. API, worker and web
production builds passed; formatting and diff checks passed.

The neutral invitation approach follows [Google's review-request guidance](https://support.google.com/business/answer/3474122?hl=en).
WhatsApp activation requires approved templates and appropriate opt-in under the
[WhatsApp Business Messaging Policy](https://whatsappbusiness.com/policy/).
