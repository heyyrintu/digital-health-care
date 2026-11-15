# Medicine release review fixes — 15 November 2026

Prepared for PR #60. The first GitHub run passed build, browser, container and three
integration shards. The remaining shard exposed stale platform permission allowlists;
the updated tests explicitly allow source review metadata and narrow reference lookups
while retaining prohibitions on clinical writes. Remote checks must rerun before merge.

## Corrections

- Offline medicine sync includes the catalogue revision. Prescribing holds selected
  medicine rows with shared locks, preventing clinic deactivation during save/signing.
- Follow-up migration 65 requires active medicines and active verified reviewers for
  catalogue eligibility, binds publication identity to its source dataset, and indexes
  review-state filters. Previously recorded migration files are unchanged.
- Repeated withdrawals allow exact lost-response retries but reject another withdrawal
  of an inactive brand. Historical amendment/PDF behavior remains intact.
- Ingredient searches reset between generics, clear stale results when the query changes,
  and disable input/results during requests.
- Shared query contracts describe release, brand and history pagination accurately.
  Mapping write limits accommodate the contract's bounded UTF-8 payload size.
- Owner import accepts BOM-prefixed manifests and requires an original package file whose
  computed SHA-256 matches the supplied checksum. Extraction from that archive remains
  an explicit owner responsibility; individual input file hashes are retained separately.
- Historical QA scope and licence text/document hash instructions are clarified. Browser
  failure artifacts are attributed only to the test that actually ran.

## Local validation

- Six related integration suites: 75 passed with migration 65, including four new
  publication/cache/concurrency cases. After strengthening fixtures, final import/review/
  publication checks totalled 39 passing cases across reruns on a fresh database.
- Three focused platform permission/return-shape checks passed.
- Review workspace browser check and isolated catalogue publication/signing browser
  check passed (2 total), using fabricated source, evidence and facts.
- Contracts 132 and translations 4 passed. Type checks, lint and API/web builds passed.
- Built import command rejected an archive checksum mismatch before input/database work.
- Populated clinical medicine/prescription rows remain unchanged after source import.
  Backfill tests retain the selected release when a second reviewed release exists.

Recorded external review and publication approval remain distinct. Historical mapping
records may have no canonical molecule ID; the separate resolved mapping/evidence gate
continues to reject those records for clinical publication. No actual licence, clinician
sign-off or independent safety approval is manufactured, and no real medicine is activated.
