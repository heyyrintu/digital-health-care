# Data Flows and Record of Processing (DPDP)

**Status:** Draft — to be reviewed by a healthcare lawyer · **Owners:** Tech lead + product owner

Roles (to confirm with lawyer): each clinic/organisation acts as **data fiduciary** for its patients; the platform operator processes data on its behalf under a **data processing agreement**; vendors are sub-processors.

| # | Purpose | Data | Source | Consent / basis | Shared with | Retention |
|---|---|---|---|---|---|---|
| P1 | Account and login | Phone, name, DOB, gender, device info | Patient, staff | Account terms + privacy notice | SMS provider (OTP) | While account active |
| P2 | Appointments and queue | Booking details, reason for visit | Patient, front desk | Service delivery | WhatsApp, SMS, email, push providers (non-clinical message content) | Per clinical retention |
| P3 | Clinical care | Vitals, history, allergies, notes, diagnoses, prescriptions, test orders, referrals, uploads | Patient, doctor, front desk | Health-data consent | DSC provider (document hash for signing) | At least 3 years |
| P4 | AI scribe | Audio, transcript, draft note | Consultation | Explicit per-consultation consent (C14) | Speech-to-text and AI model vendors | Audio 7 days; transcript with record |
| P5 | Ask AI | Patient record extracts, question, answer | Doctor | Health-data consent; doctor-initiated | AI model vendor | With audit log |
| P6 | Safety checks | Medicines, allergies, conditions, age, weight | Record | Care delivery | Drug database (no patient identity sent) | n/a |
| P7 | Payments | Bill, amount, payment status, method; patient name and phone for links | Front desk, patient | Service delivery | Cashfree | Financial records rules |
| P8 | ABDM | ABHA number/address, care contexts, consent artefacts, shared/fetched records | Patient | ABDM consent per request | ABDM gateway, other HIPs/HIUs | Per consent and clinical retention |
| P9 | Review requests | Name, phone | Record | Opt-in; opt-out honoured | WhatsApp/SMS provider | Until opt-out |
| P10 | Audit and security | User actions, IPs, devices | System | Legitimate security need | — | Per security policy |
| P11 | Migration | Historical records from current EMR | Clinic | Clinic instruction | — | As clinical records |

## Data principal rights handling
Access, correction, erasure and grievance requests are logged in `DataRightsRequest`, acknowledged promptly and closed within the timeline set by the DPDP Rules (lawyer to confirm). Erasure of clinical records is deferred until legal retention ends; the patient is told why.

## Breach response
See `runbooks/incident-response.md`. Notification to the Data Protection Board and affected data principals follows the DPDP Rules; the lawyer is engaged at the start of any suspected breach.

ADR 0025 adds optional financial availability notices under a separate `payments` WhatsApp opt-in. Meta receives the recipient phone and a short-lived authenticated portal navigation URL, not names, bill amounts, diagnoses, receipt files or refund details. Current patient/guardian contact and opt-in revision are rechecked at authorization; STOP is honored across the existing sender's categories. Authenticated financial history remains separate from public pay-only links. Provider agreements, template approval and real acceptance remain pending configuration.


Patient profile increment (ADR 0027): private photo and contact/emergency fields are accessed only by the owned, consented portal workflow. Medical facts remain patient-sourced until permitted doctor confirmation. The auth-only phone-change record holds normalized old/new contact numbers, request/actor/clinic/patient IDs and purpose-bound challenge references/expiry/completion, not plaintext codes or clinical notes. A transfer revokes affected clinic patient sessions/devices and does not transfer consent/preferences to the new number. Existing retention/rights controls and the wider production-storage backlog still apply.

ADR 0029 implements the core self-service rights workflow locally: encrypted immutable correction/erasure-review details, encrypted replies, restricted clinical review and identifier-only events/audit. Patient-facing exports are built in bounded memory and are never stored as server archives. Verified clinic-account closure revokes access/consents and queues eligible photos/unused uploads for retrying private-store deletion, while retaining clinical/financial history. The clinic must supply its retention policy and handle manual access, identity disputes and reopening. No statutory timeline or production/backup erasure completion is claimed by this implementation.

ADR 0030 adds encrypted clinic service conversations and template bodies. Meta processes the number holder's incoming/outgoing text under the clinic service workflow; phone lookup is keyed and only last-four metadata is exposed to restricted roles. Media IDs/URLs/captions are not retained or fetched. Conversations can contain unverified mixed-family information and are not automatically released in a selected-patient export. Clinic-reviewed access and transcript/backup retention policy remain required operational work. Explicit service-template consent is recorded separately; STOP and clinic patient-account closure revoke it. No marketing or AI processing is added.

ADR 0031 retains encrypted staff-reviewed session previews/receipts with keyed snapshots and identifier-only audit metadata. Appointment history receives the operational reason under the existing staff booking purpose; no clinician notes are exposed by eligibility checks. Delay estimates stay in owned appointment views. Optional generic additional update notices share the appointment opt-in purpose and send only clinic name and authenticated login URL; contact/consent/source/expiry are rechecked before one-time authorization. Queued counts do not establish delivery. Financial/care history is retained, and no automatic refund or bill transfer is introduced.
