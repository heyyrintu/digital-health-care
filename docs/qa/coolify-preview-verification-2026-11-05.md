# Coolify preview verification — 2026-11-05

Verified locally with Linux Docker containers, PostgreSQL 16, Redis 7 and synthetic records only. These results do not assert that a remote Coolify host has been deployed.

## Passed

- Built the backend, standalone web and gateway images using the frozen pnpm lockfile.
- Started the full Compose stack and waited for every long-running service to become healthy; migration service exited successfully.
- Applied all 48 migrations to a fresh database; another deployment/recreation found the database up to date.
- Verified web liveness, API liveness/database readiness and gateway routing. Production API startup passed the PDF rebuild self-test.
- Manually bootstrapped the fresh synthetic database: one organisation and six patients, with normal staff invitations. A second bootstrap was refused.
- Ran the real gateway authentication flow: invitation/password setup, authenticator confirmation, secure HttpOnly SameSite session cookie, protected patient-list access, refresh, password login and MFA. Rejected a different Origin. No logged OTP or auth bypass was enabled.
- Rehearsed the browser interface at 1280 px and 390 px: styled login/notice, no horizontal overflow, doctor invitation/MFA and authenticated dashboard; no browser script errors. Local browser requests were routed through the real HTTP gateway under the configured public origin; this does not test a real TLS certificate.
- Recreated all long-running containers and verified the same six patients and private-file contents survived.
- Ran the paired maintenance-window backup script. Restored database and files into a separate stack/volumes with the original encryption key, verified six patients, 48 migrations and matching file contents, then repeated the complete authentication smoke against the restored stack.
- Web unit suite: 220 tests passed. New readiness tests: two passed. API unit run: 217 passed initially; the three port-dependent failures were environment permission failures and passed when that four-test suite was rerun with local-port access.
- API/web lint, API/worker typechecks, web build TypeScript checks, formatting, shell syntax, JavaScript syntax and diff whitespace checks passed. Other unchanged workspace checks were already cached in the scoped check run.

## Corrections found by the container rehearsal

Worker database runtime dependencies are now explicit, preventing a bundled CommonJS dynamic-require startup crash. nginx now resolves changed Docker service addresses after deployment. Web session origin checks use the configured external origin, allowing the private standalone server behind a proxy without trusting arbitrary forwarded hosts. Login/invitation pages read the preview notice at runtime.

## Actual-host acceptance still required

Set the final hostname, TLS/domain mapping, actual proxy subnet and generated secrets in Coolify. Deploy the branch containing all local changes, run the synthetic bootstrap privately, establish presenter passwords/MFA, configure host monitoring/off-host backups, repeat the restore procedure on that host and rehearse the client walkthrough. Patient OTP, outbound WhatsApp, Cashfree, legal signing and AI remain deferred/off; no native app build or real provider traffic occurred.

The GitHub container-verification workflow is added; its execution on GitHub has not been claimed. A host macOS Next build was prevented by local process/port restrictions; the target Linux Docker web build completed successfully. No PR, push or remote deployment was performed. Disposable local stacks were removed after verification.
