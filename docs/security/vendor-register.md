# Vendor and DPA Register

**Status:** Draft · **Owner:** Product owner · **Review:** on any vendor change and yearly.

| Vendor category | Chosen vendor | Data shared | Region | DPA signed | Security review | Sandbox | Status |
|---|---|---|---|---|---|---|---|
| Cloud hosting | AWS (ap-south-1 Mumbai) | All platform data | India | ☐ | ☐ | — | Decided |
| Payment gateway | Cashfree Payments | Bill amounts, patient name/phone for links | India | ☐ | ☐ | ☐ | Decided |
| WhatsApp provider (BSP) | TBD | Phone, message templates (no clinical content) | TBD | ☐ | ☐ | ☐ | Open |
| SMS provider (DLT) | TBD | Phone, OTP, message templates | India | ☐ | ☐ | ☐ | Open |
| Email | TBD (e.g. AWS SES) | Email, documents (receipts, prescriptions) | TBD | ☐ | ☐ | ☐ | Open |
| Push | Firebase Cloud Messaging, Apple Push | Device tokens, notification text (no clinical content) | Global | ☐ | ☐ | — | Decided |
| Cloud DSC signing | TBD (shortlist two) | Document hash, doctor certificate operations | India | ☐ | ☐ | ☐ | Open |
| Drug database | TBD | Medicine and molecule queries (no patient identity) | TBD | ☐ | ☐ | ☐ | Open |
| Speech-to-text | TBD | Consultation audio | Approved region | ☐ | ☐ | ☐ | Open |
| AI model (scribe, Ask AI) | TBD | Transcripts, record extracts | Approved region | ☐ | ☐ | ☐ | Open |
| ABDM | National Health Authority gateway | ABHA, consents, FHIR records | India | Per ABDM terms | NHA review | ☐ | Decided |
| Error tracking / monitoring | TBD | Technical logs (no PHI) | TBD | ☐ | ☐ | — | Open |

Minimum contract terms for any vendor touching patient data: purpose limitation, no training on our data, sub-processor disclosure, breach notification, deletion on termination, data location, audit rights.
