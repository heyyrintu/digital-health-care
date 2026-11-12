# Medicine-data source assessment — 12 November 2026

## Recommendation

Use **Common Drug Codes for India (CDCI), published by NRCeS / C-DAC**, as the first
candidate for the Indian medicine catalogue. Import an approved release into our own
PostgreSQL database, retain source identifiers/version and keep clinic additions separate.
The official flat-file archive has now been downloaded by the owner and inspected.
The package licence states CC BY 4.0 and permits implementation products/services and
redistribution within India, while retaining applicable SNOMED CT affiliate-licence
requirements for included International Release content. Owner affiliate-licence status
is still pending; no production import is approved by this assessment.

The official release page offers substances, generic and branded medicines, suppliers,
dose forms and other terminology in flat files, designed for prescription/dispensing and
other healthcare software. A terminology-integrated package is available through SNOMED
CT affiliate licensing. NRCeS confirms SNOMED CT use in India is free but still requires an
affiliate licence and applicable sublicensing; this is not unrestricted worldwide use.
The flat-file package has its own included `License.txt`, now inspected. Attribution,
licence notices and applicable SNOMED terms must be preserved.

Official sources:

- https://www.nrces.in/services/national-releases#drug_codes
- https://www.nrces.in/resources — lists a 31 August 2026 CDCI release.
- https://www.nrces.in/faqs — licensing, Indian deployment and international-use conditions.

## Comparison

| Source | Usefulness | Free/access position | Decision |
| --- | --- | --- | --- |
| NRCeS CDCI | Indian generic/brand terminology, ingredients, suppliers and dose forms; local import possible | Free India SNOMED affiliate route confirmed. Flat-file licence inspected: CC BY 4.0 plus applicable SNOMED affiliate terms; download completed by owner | First candidate; verify package terms and coverage before publishing |
| NHA / ABDM Drug Registry | Official Indian medicine registry with public search and documented APIs | Public browsing works; production API credentials, quotas, caching/redistribution terms and charges not verified | Evaluate as an additional registry/update source; no full ABDM patient integration initiated |
| NLM RxNorm | Normalized generic ingredient/strength/form identifiers and search | Core API generally does not require a licence; full dataset contains additional licensed vocabularies. U.S.-centric, poor coverage of non-U.S. medicines | Optional supplementary mapping, not the Indian brand master |
| PMBI Jan Aushadhi | Official programme product/MRP list | Copyright policy allows free reproduction after permission, accurate use and acknowledgement, excluding third-party material | Useful programme-specific supplement after permission; not all Indian brands |
| DrugBank | Drug knowledge and interactions | Commercial use requires a commercial agreement; academic free access is restricted | Does not meet this app's free commercial-data requirement |

Primary references:

- https://www.pib.gov.in/PressReleasePage.aspx?PRID=2278991&lang=1&reg=3
- https://drugregistry.abdm.gov.in/dr/v3
- https://drugregistry.abdm.gov.in/dr/v3/faq
- https://lhncbc.nlm.nih.gov/RxNav/APIs/RxNormAPIs.html
- https://www.nlm.nih.gov/research/umls/rxnorm/faq.html
- https://www.nlm.nih.gov/research/umls/rxnorm/docs/termsofservice.html
- https://www.janaushadhi.gov.in/copyright
- https://www.janaushadhi.gov.in/faq
- https://trust.drugbank.com/drugbank-trust-center/drugbank-terms-of-service

## Live checks and remaining gates

- The official Drug Registry public site rendered and showed a data update date of
  11 November 2026. Its FAQ describes external APIs and public browsing; some FAQ copy
  still describes API details as forthcoming, so it cannot establish current production
  entitlement or price. An API specification is linked from its Resource Center.
- The owner completed the official download CAPTCHA and the archive is present in Downloads.
  Its CRC is valid and its `License.txt` and all seven master tables were inspected. No
  account registration or licence agreement was submitted by the assistant.
- Pending: confirm the owner's applicable affiliate licence, clinical coverage review,
  external-ID mapping and validated import/update handling. See the inspection report below.
- No data was imported into the hosted app. Synthetic demo medicine data remains unchanged.

## Catalogue and clinical safety are separate

Do not turn medicine names or RxNorm identifiers into unverified dosing or interaction
rules. NLM's RxNav drug/drug interaction features were discontinued on 2 January 2024:
https://lhncbc-portal.lhcaws-prod-pub.nlm.nih.gov/RxNav/information/FAQs.html

Clinical safety facts need a separately checked source and clinician review. An unmatched
medicine or unavailable evidence must never be presented as proof of no interactions.
Do not import scraped pharmacy/Kaggle data solely because a download is free.

## Next implementation steps after source approval

1. Inspect the official package and licence; archive provenance privately as appropriate.
2. Build a versioned, repeatable staging import with validation and a dry-run report.
3. Review an orthopaedic-clinic sample for brand/generic, ingredient, strength, form and route.
4. Publish only approved catalogue rows; preserve existing signed-prescription snapshots.
5. Add search and clinic favourites; sync by reviewed official releases rather than live
   provider calls for every prescription.

## Download inspection

Archive: `/Users/getitrent/Downloads/CommonDrugCodesForIndia_FlatFilePackage.zip`

SHA-256: `aebd30ac95d73accf573c86fd4dae1dc90eff03ae0fbcd312bc761011e88270a`

| File | Rows |
| --- | ---: |
| BrandMaster | 93,911 |
| GenericMaster | 10,305 |
| ProductMaster | 72,284 |
| SupplierMaster | 8,213 |
| SubstanceMaster | 3,283 |
| DrugFormMaster | 423 |
| RouteOfAdministrationMaster | 160 |

No empty identifiers or duplicate identifiers were found in any master. Trailing empty
TSV columns were present and can be ignored; there were no nonempty unexpected columns.
All brand product/supplier links resolve. Fourteen brand rows have missing/unresolved
generic links (6 blank, 8 unresolved); quarantine these before any publication. The remaining
93,897 brand rows are structurally linked candidates, not clinically/regulatorily approved
records. All referenced generic substance, route and form codes resolve within the package.

Every brand row has regulatory `License Status=UNKNOWN`. This is different from the
software/data licence. Do not label catalogue entries as regulator-approved on this evidence.
Only 321 generic rows contain the free-text drug-interaction field; absence is unknown,
not a no-interaction result. Indication/contraindication fields are also incomplete.

The archive itself contains no explicit release manifest. Source record updates range
up to August 2026; retain the archive checksum and provenance rather than invent a release
version. Do not infer numeric strengths/doses solely from names without validated mapping.
The current database also needs source-ID/version fields or a mapping table before a
repeatable import; source identifiers must remain strings.

Inspection artifacts (local, not loaded into the hosted application):

- `/private/tmp/dhc-cdci-inspection-2026-11-12/inspection.json`
- `/private/tmp/dhc-cdci-inspection-2026-11-12/brand-reference-quarantine.csv`
- `/private/tmp/dhc-cdci-inspection-2026-11-12/License.txt`

Licensing references:

- https://creativecommons.org/licenses/by/4.0/
- https://www.nrces.in/faqs

## Owner decision and development continuation

The owner deferred affiliate licensing ("Check later"). Real data remains excluded from
live publication. A synthetic-only offline staging tool is now implemented; see
`docs/runbooks/medicine-catalogue-staging.md`. The official archive was not bundled into
source code, imported into a database, or used as a test fixture for this increment.
