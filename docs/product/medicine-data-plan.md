# Medicine catalogue plan

The repository currently seeds a small **synthetic, illustrative** medicine catalogue.
It is useful for demonstrations, not a validated Indian brand master or a prescribing
reference. Existing clinic medicine search, custom entries and approval workflows are the
starting point for the catalogue work below.

| Stage | Deliverable | Acceptance |
| --- | --- | --- |
| 1. Source | Licensed Indian generic/brand data feed, or an authorised clinic spreadsheet | Written reuse rights and named clinical reviewer; source fields and update cadence agreed |
| 2. Import | Admin-only preview and reviewed publication | Validate ingredient identities, strengths and units, formulation, route, brand/manufacturer, source ID, version and active status; reject invalid rows and flag duplicates |
| 3. Prescribing search | Generic and brand search with strength/form displayed; clinic favourites and custom entries | Clinician can distinguish similar products; local entries stay clinic-scoped; master IDs remain stable across updates |
| 4. Maintenance | Versioned updates, provenance and withdrawal/deactivation handling | Existing prescriptions retain their original medicine snapshot; updates cannot rewrite signed records |
| 5. Clinical facts | Independently sourced, versioned interaction/allergy/dose information | Licensed evidence and clinical approval before enabling any decision support; product catalogue alone does not establish safe doses |

Begin with stage 1 and an import sample reviewed by the clinic. Do not scrape retail
pharmacy listings or generate clinical facts with AI. Do not bundle a paid feed without
permission. The owner must choose/authorise the data source; no purchase is implied by
this plan. Until validated data is loaded, keep synthetic preview records clearly marked.

Mobile, AI providers, cloud prescription signing and ABDM remain outside this increment.
