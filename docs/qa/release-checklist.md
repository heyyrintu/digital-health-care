# Release Checklist

**Owner:** QA engineer (sign-off) · Tech lead (approve) · Copy this list into each release ticket.

## Before release
- [ ] All CI checks green on the release commit (types, lint, unit, integration, tenant isolation, contract tests).
- [ ] Database migrations reviewed; expand/contract safe; tested on staging copy.
- [ ] Full end-to-end suite passed on staging (web + Maestro on iOS/Android phone and tablet).
- [ ] Safety rule pack passed; clinical sign-off if rules changed.
- [ ] Cashfree sandbox payment, link, refund and webhook replay passed.
- [ ] WhatsApp → SMS fallback test passed.
- [ ] No open critical/high defects.
- [ ] Release notes drafted (`release/release-notes-template.md`).
- [ ] Feature flags set for production (e.g. ABDM features if review pending).
- [ ] Rollback plan noted (previous image tag, migration compatibility).

## Mobile-specific
- [ ] Version and build numbers incremented for both apps.
- [ ] EAS builds produced for Patient and Clinic apps (iOS + Android).
- [ ] TestFlight and Play closed testing smoke passed by clinic testers.
- [ ] Store listing, screenshots, privacy answers unchanged or updated (`store/store-submission-pack.md`).
- [ ] Minimum supported version / forced-update threshold reviewed.
- [ ] OTA update only if JS/asset-only and within reviewed behaviour.

## Release
- [ ] Web/API blue-green deploy; health checks green; error rate normal for 30 minutes.
- [ ] Mobile staged rollout started (Play 10% / App Store phased release).
- [ ] Monitor crash-free sessions, API errors, payment success rate, message delivery for 24 hours.

## After release
- [ ] Play: staged rollout increased 10% → 50% → 100% if metrics healthy.
- [ ] App Store: seven-day phased release continuing; pause it if crash rate or errors rise.
- [ ] Release recorded: version, date, migrations, approver.
- [ ] Changelog updated; clinic informed of user-visible changes.
