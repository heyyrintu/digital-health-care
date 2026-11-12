# Synthetic medicine review sandbox — 12 November 2026

Implemented locally on `codex/medicine-catalogue-staging`. Not deployed by this increment.
All medicine sources used for these checks were fabricated fixtures; no real CDCI rows
were loaded and no licence was accepted or registered.

## Result

- `/platform/medicines` supports synthetic bundle upload, immutable staged snapshots,
  candidate search, quarantine/provenance inspection, differences from the active
  sandbox, review/rejection notes and sandbox activation/reactivation.
- The platform token and network allowlist protect every endpoint. Clinic identity
  roles cannot read the new tables. Platform access does not grant clinical writes.
- Snapshot versions are immutable. Identical uploads return their original snapshot;
  replacements under an existing version fail. Review revisions and the expected
  active snapshot prevent stale decisions from overwriting newer work.
- Browser/API imports are limited to 2 MiB, 500 candidates and 2,000 report entries.
  The CLI emits a browser bundle only when it fits those bounds.
- Real-data publication, clinical mapping and licensing remain pending. Synthetic
  declarations are operator assertions; checksums cannot establish authenticity or
  recreate derivation without the original source tables.

## Validation

| Check | Result |
|---|---|
| Offline staging/review unit tests | 31 passed |
| New medicine + existing platform integration suites | 66 passed; 1 existing optional check skipped |
| Shared contract tests, including OpenAPI security classification | 129 passed |
| English/Hindi message consistency | 4 passed |
| Browser workflow | Passed: upload, quarantine, review, publication, persistence after reload, real-manifest rejection; medicine count unchanged |
| API/web/contracts/e2e type checks and lint | Passed |
| Production API build | Passed |
| Production web build | Passed with `next build --webpack`; Turbopack's local helper could not bind a port in this environment |
| Database migration | All 60 migrations applied successfully to fresh throwaway databases |
| Patch whitespace | `git diff --check` passed |

Integration checks cover duplicate and malformed bundles, false safety claims, incomplete
review acknowledgement, racing review decisions, stale sandbox publication, reactivation,
pagination with tied timestamps, rejected snapshots, network/authentication boundaries,
database grants, audit metadata and unchanged clinical tables.

No live credentials, patients, prescriptions, clinic medicine rows or deployment settings
were changed. Temporary databases were used only for this verification.
