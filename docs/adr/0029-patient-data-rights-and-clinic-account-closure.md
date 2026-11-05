# ADR 0029: Patient data rights and clinic account closure

Status: Implemented locally; production acceptance outstanding
Date: 2026-11-05

## Decision

Provide `/app/data-rights` outside the consent-gated portal shell. A signed-in patient can exercise this explicit purpose after withdrawing health-data consent, without accepting that consent again. Family selection is limited to currently owned live profiles in the signed-in clinic. `/clinic/data-rights` supports clinic-admin review of profile/financial requests and assignment of clinical requests to active doctors with chart access. Front desk has no rights-queue access.

### Downloads

POST `/v1/data-rights/export` takes a stable request UUID and one currently owned patient ID. It creates a tracked request and returns a private, uncached ZIP containing `data.json`, `README.txt` and available files. The snapshot includes merged history, profile/photo, consent history, the requester's selected-patient requests, visits, finalized consultation notes excluding `privateNotes`, chart facts/vitals, non-draft prescriptions, bills/payment/refund ledger data, placed tests/results, ready personal uploads (including care-used hidden files), signed referral letters and non-withdrawn clinic-shared documents. Draft consultations/prescriptions, clinician private notes, withdrawn clinic documents, deleted uploads, other patients and internal identity/provider/security payloads are excluded. Further access requires clinic review; this is not a claim that every legally accessible record is automatically published.

Files with stored SHA-256 values must match before delivery; a missing or mismatched file fails the complete export. Prescription rendering reuses the existing signed/void PDF service. Profile photos have no stored digest and are bounded separately. Public JSON contains generated archive paths, never storage keys or clinical ciphertext. The archive stays in bounded process memory: at most 300 entries, 50 MiB of content and 2,000 rows per collection; exceeding a limit gives a tracked failure with clinic-assistance instructions, never a silently truncated archive. At most two exports per process and one per clinic/account run through construction and response completion. Abandoned responses do not free a still-building slot. Response close/finish cleanup is idempotent. Rate limits also apply. These are process limits, not a distributed global quota.

A retry of the same export UUID rebuilds a fresh snapshot after full authentication and ownership checks. `fulfilled` means prepared, not proof that the browser saved it. Final ownership checks cover all exported profile/history IDs. ZIP bytes are never persisted by the server. Patients must protect downloaded copies themselves.

### Correction and erasure review

Initial request details and patient-visible replies are encrypted. The initial subject, scope, message and creation time are immutable. Events and audit records contain identifiers/actions/times, not request text. Revisions protect assignment/decisions/withdrawal; terminal decisions are immutable. The requester sees their own history, with subject demographics hidden if current family ownership is lost.

Admins see clinical metadata only. Only the assigned active chart-authorised doctor sees clinical text/replies and can decide it. Profile completion applies a validated, allowlisted correction atomically with the decision; phone, UHID, guardian links, confirmed clinical facts and signed history cannot be changed this way. Clinical completion requires a same-patient correction made after submission (revised consultation, signed amendment or void). Financial completion requires a posted same-patient refund after submission; other financial adjustments remain clinic-assisted. Reviewers perform those corrections in the existing clinical/ledger workflow first.

Erasure completion requires evidence that the referenced unused personal upload has already been purged. Clinical/financial records are not automatically erased. A retained decision requires a clinic policy reference; optional review dates are review metadata, not deletion timers. No legal retention duration is invented here. Patients can withdraw open correction/erasure requests. General manual access, identity disputes and retention exceptions remain clinic responsibilities.

### Account closure

The patient explicitly confirms the scope, then verifies a fresh purpose-bound OTP to the current verified number (five-minute validity, five guesses). Stable preparation IDs prevent retries from sending another code automatically. Closure codes cannot sign in or authorise phone changes. Failed guesses commit even when validation is refused.

One atomic transaction locks the clinic/account access row exclusively while normal portal work holds shared locks. It closes current-clinic patient access and owned family profiles, withdraws account consents, disables the source number's clinic WhatsApp preferences, revokes patient sessions/devices and record shares, queues unused uploads for durable deletion, hides care-used uploads without changing their protected file/revision/history, and queues profile-photo deletion. It records a closure receipt. Clinical/financial records and scheduled appointments remain intact; closure does not cancel visits or refund payments. Global identity, staff sessions and other-clinic patient memberships stay intact. Ordinary sign-in and phone transfer cannot reopen a closed clinic account or reclaim its closed profiles. Reopening requires a future clinic identity-review process; it is not implemented as a self-service toggle.

Photo deletion uses an idempotent durable retry queue in the API sweep. Personal upload deletion reuses ADR 0028's leased purge. Deletion completes when the private store confirms removal; retained care files never enter that queue. Backups, production object-store retention and operational policy remain separate acceptance work. If the final HTTP response is lost, closure may already be committed and the patient must retain the displayed attempt reference and contact the clinic; a revoked session cannot fetch a new receipt.

## Acceptance limits

Local synthetic database and browser verification does not activate Meta, establish a legal retention policy, deploy production storage/scanning, prove backup erasure or complete a clinic pilot. Native app work is paused. Cloud DSC and AI remain deferred by the owner. No PR or deployment is part of this increment.
