# ADR 0008: Server-side signing with cloud Class 3 DSC

- **Status:** Accepted
- **Date:** 2026-10-06
- **Deciders:** Tech lead, platform owner
- **Related:** Build Plan decision D8

## Context
Prescriptions must carry a legally recognised electronic signature, and doctors sign from phones and iPads where USB tokens cannot be used.

## Options considered
| Option | For | Against |
|---|---|---|
| Aadhaar eSign | Legally recognised | OTP per prescription; per-signature fee; slow at clinic volume |
| USB DSC token | Low cost | Does not work on phones/iPads |
| Cloud (remote) Class 3 DSC | Works on any device, fast, legally recognised | Vendor dependency; integration effort |

## Decision
Sign on the server through a cloud DSC provider after doctor approval with biometrics (mobile) or PIN (web). Provider behind an adapter.

## Consequences
- Certificate never leaves the provider; signing events audited.
- Shortlist two providers in phase 0; staging uses test certificates.

## Review trigger
Provider pricing or reliability changes; regulation changes.

## Addendum (2026-10-19): referral letters
Referral letters (PRD §7.2: "Signed referral letter PDF") are signed with the same machinery, not a copy of it: the same signer adapter (`PrescriptionSigner`; the test key in development and staging, refused in production like for prescriptions), the same signing PIN with one failure counter and the same 15-minute pause, the same requirement of a verified registration and a complete prescription pad, the same flow (preview marked PREVIEW, then PIN, then a PDF rendered on the server from a versioned template, its SHA-256 signed and stored with the file's key) and the same QR code format. The PDF building blocks (fonts, mixed English and Hindi text, letterhead, signature block, QR, watermark, page numbers) moved to `apps/api/src/documents/pdf-kit.ts`, shared by both templates; prescriptions render byte for byte as before, so `rx-2` was not bumped.

What differs, and why:
- **One letter per referral, never changed.** A letter has no amendments or voiding yet: it records what was referred and may already be with the patient or the receiving doctor. The table is insert-only, enforced by triggers for every role. Withdrawing a letter (a VOID copy, as for prescriptions) is left until a clinic needs it.
- **Only the referring doctor signs**, only while the referral is not closed; closing it afterwards leaves the letter valid.
- **Its own QR lookup and page** (`referral_letter_verifications`, `POST /verify/referral-letter`, `/verify/referral/<code>`), not a wider `POST /verify`: the prescription check's contract and the QR codes already printed stay unchanged, and a code from one kind of document can never vouch for the other. The page reuses the prescription check's component.
- The signer's name stays `PrescriptionSigner` for now; it signs a document hash and knows nothing about prescriptions. Rename it when the DSC provider is wired.
