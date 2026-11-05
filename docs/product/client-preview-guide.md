# Client progress demonstration: web version

Use the separate Coolify client-preview deployment with synthetic data only. A visible notice identifies it throughout the web interface. Set up the three staff accounts and authenticators before the meeting; there are no shared demonstration passwords. Keep the deployment URL and credentials private.

## Suggested 15–20 minute presentation

1. **Reception:** sign in as front desk. Show the patient list and synthetic profiles. Register another clearly fictional patient, book or create a walk-in, check in and capture vitals. Explain the separate front-desk and doctor access.
2. **Doctor workflow:** use a separate browser profile for the doctor. Open today's queue, select the checked-in patient and show the consultation workspace: history, vitals, notes, diagnoses, prescription draft and test orders. Save the draft and show it survives navigation. Final legal signing remains deferred.
3. **Clinic operations:** show appointment scheduling, cancellations and the reviewed bulk session/delay preview. Review which bookings can change and which require individual attention before applying changes. Show the resulting receipt and audit history.
4. **Billing and administration:** show billing, cash/manual payment workflows, staff/settings and reports using synthetic records. Explain that online Cashfree payments and automatic WhatsApp delivery are implemented behind configuration and remain switched off for this preview.
5. **Documents and privacy:** show synthetic document uploads, doctor-only access where applicable, and audit visibility. Explain that the patient portal, records, sharing and data-rights work exists; live patient login needs the Meta OTP configuration. Do not use a real patient's phone number or bypass OTP.
6. **Close with progress and scope:** the web/API/background-service stack is deployed with persistent storage, migrations, health checks and a backup procedure. Native app work, AI providers, cloud DSC signing and the remaining feature backlog are outside this presentation.

Use one browser profile per role to avoid accidentally sharing the wrong staff session. Prepare one waiting patient and one saved consultation draft before the meeting. Use synthetic file contents without real names or clinical details. Do not show authenticator QR codes, private invite links, environment variables, server terminals or raw patient-export archives on the presentation screen.

## Demo acceptance before sharing the URL

- HTTPS works without browser warnings; desktop and phone-width pages load styled assets.
- Staff invite acceptance, password login and authenticator confirmation work over the deployed hostname.
- Reception can register/book/check in a synthetic patient; doctor can open the same queue entry and save a draft.
- A sample upload can be opened by the authorised role after an API/container restart.
- Reports/settings and the operational review/receipt screen load without developer error screens.
- Preview notice and search-engine exclusion are present; provider features remain off.
- Health checks are green; a matched database/file backup and isolated restore have been verified on the host.

Do this rehearsal on the actual Coolify hostname before the client meeting. Local builds and container checks cannot verify that server's DNS, TLS, proxy network, email delivery or external provider accounts.
