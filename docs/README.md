# Documentation Set — Dr. Siddharth Gupta Digital Healthcare Platform

Living documents for the build. Product scope is in **PRD v3.0 (Final)** and the delivery approach in the **Build Plan — Web, iOS and Android**. Exported copies are in `product/`; the editable masters stay in Claude Docs, so re-export after changing them. Everything here sits in the repository so it changes with the code.

**Rule:** a pull request that changes behaviour updates the relevant document in the same pull request.

| Document | Path | Owner | Update when |
|---|---|---|---|
| **PRD v3.0 (Final)** | `product/PRD-v3.0-Final.pdf` | Product owner | Scope changes (master copy in Claude Docs) |
| **Build Plan — Web, iOS and Android** | `product/Build-Plan-Web-iOS-Android.pdf` (+ `.docx`, `build-plan.md`) | Tech lead | End of each phase (master copy in Claude Docs) |
| Architecture decision records (ADR 0001–0015 + template) | `adr/` | Tech lead | Before a decision is implemented or changed |
| API guide and endpoint catalogue | `api/api-guide.md` | Backend lead | Every API change (reference itself is generated from OpenAPI) |
| Webhooks guide (Cashfree, WhatsApp, SMS, ABDM) | `api/webhooks.md` | Backend lead | Provider or event change |
| Data dictionary | `data/data-dictionary.md` | Backend lead | Every migration |
| Safety rule catalogue (clinical sign-off) | `safety/safety-rule-catalogue.md` | Product owner + clinical advisor | Any rule change |
| Threat model | `security/threat-model.md` | Tech lead | Quarterly, new integration |
| Data flows and record of processing (DPDP) | `security/data-processing-record.md` | Tech lead + lawyer | New data use or vendor |
| Vendor and DPA register | `security/vendor-register.md` | Product owner | Vendor change |
| Access control policy | `security/access-control.md` | Tech lead | Role change |
| Test plan | `qa/test-plan.md` | QA engineer | Each phase |
| Release checklist | `qa/release-checklist.md` | QA engineer | Each release |
| Runbooks | `runbooks/` | DevOps | After every incident or drill |
| Store submission pack | `store/store-submission-pack.md` | Product owner | Each store release |
| User guides and FAQ | `guides/` | Product designer | Each feature release |
| Release notes template and changelog | `release/` | Product owner | Each release |

## Status legend
Documents start as **Draft**. They become **Approved** when the named owner signs off in the pull request. Items marked `TBD` depend on open decisions in PRD §1.2.

## Data rule for all documents
Never paste real patient data (names, phone numbers, prescriptions, screenshots) into any document, ticket, test or prototype tool. Use the synthetic personas in `qa/test-plan.md`.
