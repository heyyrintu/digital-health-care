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
