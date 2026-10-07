# Runbook: Store Submission

**Owner:** Mobile lead · **Inputs:** `store/store-submission-pack.md`

1. Bump versions; build both apps with EAS (production profile).
2. Submit to App Store Connect and Google Play with EAS Submit.
3. iOS: attach build to the version; check privacy labels and review notes; add reviewer demo accounts (staging-like review environment, synthetic data only); submit for review.
4. Android: upload to closed testing → promote to production with staged rollout; confirm Data safety and health declarations unchanged.
5. If rejected: read the cited guideline, fix or reply in Resolution Center with clarification, resubmit; log the reason in the store pack for future submissions.
6. After approval: phased release / staged rollout per `qa/release-checklist.md`.
