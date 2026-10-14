# Safety Rule Catalogue

**Status:** Draft — requires clinical sign-off before any rule goes live · **Owners:** Product owner + clinical advisor · **Engine:** `packages/safety` (rules) + licensed drug database (reference data)

The catalogue defines *what* each rule checks and *how severe* it is. Drug facts (interactions, doses, pregnancy categories) come from the licensed drug database, never from this file. Examples below are illustrations for test design and must be confirmed against the licensed database by the clinical advisor.

## Severity levels

| Level | Effect in the prescription builder | Can the doctor proceed? |
|---|---|---|
| Block | Red; signing disabled | Only if the rule is marked *overridable* by the database, with a typed reason |
| Warn | Amber; needs acknowledgement | Yes; some warnings also need a typed reason |
| Info | Blue; shown, no action | Yes |

All alerts and actions are stored in `SafetyAlert` and appear in the audit log.

## Rules

| ID | Rule | Inputs | Severity | Reason required | Clinic can tune |
|---|---|---|---|---|---|
| SR-01 | Allergy — direct molecule match | Allergy list, line molecules | Block | Override not allowed | No |
| SR-02 | Allergy — same drug class | Allergy class, molecule class | Block | Override not allowed | No |
| SR-03 | Allergy — cross-sensitivity (e.g. penicillin → cephalosporin) | Allergy class, cross-sensitivity table | Warn | Yes | No |
| SR-04 | Drug–drug interaction: contraindicated | All lines + current medications | Block | If overridable | No |
| SR-05 | Drug–drug interaction: major | Same | Warn | Yes | No |
| SR-06 | Drug–drug interaction: moderate / minor | Same | Info | No | Visibility only |
| SR-07 | Duplicate molecule | All lines + current medications | Warn | No | No |
| SR-08 | Duplicate therapeutic class (e.g. two NSAIDs) | Same | Warn | No | Visibility only |
| SR-09 | Drug–condition (e.g. NSAID with chronic kidney disease) | Conditions, molecule rules | Warn | Yes | No |
| SR-10 | Pregnancy — contraindicated | Vitals.pregnancyStatus, molecule pregnancy data | Block | If overridable | No |
| SR-11 | Pregnancy / breastfeeding — caution | Same | Warn | No | No |
| SR-12 | Child (<12 y) weight-based drug with no weight recorded today | Age, Vitals.weightKg, molecule.weightBased | Block | No | No |
| SR-13 | Child dose outside mg/kg/day range | Weight, dose, frequency, range | Block | If overridable | No |
| SR-14 | Maximum daily dose exceeded | Dose × frequency, age band | Block | If overridable | No |
| SR-15 | Older adult (65+) potentially inappropriate medicine | Age, molecule flag | Info | No | Visibility only |
| SR-16 | Kidney adjustment needed | Conditions / latest eGFR if recorded | Warn | No | No |
| SR-17 | Liver caution | Conditions | Warn | No | No |
| SR-18 | Telemedicine: Prohibited list in online consultation | Consultation mode, molecule list | Block | Never | No |
| SR-19 | Telemedicine: List B outside a follow-up | Mode, follow-up flag | Warn | Yes | No |
| SR-20 | Completeness: missing dose, frequency or duration | Line fields | Block | Never | No |
| SR-21 | Unverified patient-reported data used | Allergy/condition source | Info label on related alerts | — | No |
| SR-22 | Free-text medicine (not in master) | Line without medicineId | Warn: "Safety checks limited for this medicine" | No | No |

## Behaviour rules
- Checks run live as each line is added and again on the server before signing; the server result is final.
- AI-scribe-suggested lines are checked exactly like typed lines.
- Disabling or downgrading SR-01, SR-02, SR-04, SR-10, SR-12, SR-18, SR-20 is not possible in settings.
- A clinic admin can hide only the "Visibility only" rules (SR-06, SR-08, SR-15) under **Chart, safety alerts and files**; hidden rules are skipped in every check from then on, and the setting and the database refuse any other rule (API guide §3l).
- Every override records doctor, reason, time and the database version used.
- Monthly alert review: alerts shown vs accepted vs overridden, to tune non-critical visibility and reduce alert fatigue.

## How the engine reads the inputs (for clinical sign-off)
The engine is `checkPrescription` in `packages/safety`, and the test pack is `packages/safety/src/engine.test.ts`. These choices are the engine's, not the licensed database's. Each needs the clinical advisor's confirmation:

- **Chart text:**
  - Allergies and current medicines are free text, matched by whole words (case-insensitive, plural allowed). An allergy matches a molecule or a class: "Penicillin" or "Penicillins" matches the Penicillin class. A current medicine matches molecules by name only: "Warfarin 5 mg" matches warfarin, but a class such as "NSAID" alone is not matched.
  - Only active chart entries are used. Patient-reported entries are checked like any other, and their alerts are labelled unverified (SR-21).
- **Conditions:**
  - Kidney disease is ICD-10 N17–N19 or a name with *kidney*, *renal* or *CKD*.
  - Liver disease is B15–B19 or K70–K77, or a name with *liver*, *hepatic*, *hepatitis* or *cirrhosis*.
  - Drug–condition rules (SR-09) carry their own codes and terms.
- **Age bands:**
  - Children are under 12 for SR-12 and SR-13.
  - The maximum daily dose (SR-14) applies from 12, and also when the date of birth is unknown.
  - Older adults are 65 and over (SR-15).
- **Weight and pregnancy:** both come only from this visit's vitals.
- **Daily dose:**
  - It is worked out from the dose, the frequency and the ingredient's strength (per tablet, capsule, sachet, drop or puff, or per ml).
  - Slot amounts other than 1 count tablets ("2-0-1" is 3 tablets); for a measured dose they multiply it.
  - For a tapering course the highest step counts.
  - The same molecule is summed across lines.
  - As-needed (SOS/PRN), weekly, monthly and free-text frequencies, and creams, have no daily total, so SR-13 and SR-14 do not fire for them. Alternate-day doses count the amount on a dosing day.
- **Interactions and duplicates (SR-04 to SR-08):**
  - They are checked between lines, and between each line and current medicines.
  - Molecules within one combination product are not checked against each other.
- **Breastfeeding:** a lactation contraindication is a warning (SR-11), since SR-10 covers pregnancy only.
- **Telemedicine:**
  - Audio and video consultations are online.
  - A follow-up (SR-19) means the same doctor has an earlier completed visit with the patient.
- **Completeness (SR-20):** every step needs a dose and a frequency, and a duration unless the frequency is STAT.
- **Limited checks (SR-22):** this warning also fires for a medicine in the master that has no ingredients recorded.
- **Answers to alerts:**
  - An alert keeps its answer while the same problem fires. The key is the rule, the line and the subject; for SR-13 and SR-14 the subject includes the exact daily amount in mg, so any change of dose needs a new answer.
  - An alert that stops firing is logged as `changed`.

## Test pack (minimum cases per rule)
Each rule needs at least one positive case (fires) and one negative case (does not fire), using synthetic personas. The negative case is the same persona with the trigger removed: no allergy, a different molecule, weight recorded, a dose within range, an in-person consultation, a complete line.

| Persona (synthetic) | Exercises |
|---|---|
| Adult with recorded penicillin allergy | SR-01/02 (amoxicillin), SR-03 (cefixime) |
| Adult on warfarin | SR-05 (with an NSAID such as ibuprofen), SR-08 |
| Adult with chronic kidney disease | SR-09, SR-16 |
| Adult with asthma | SR-09 (non-selective beta-blocker) |
| Pregnant patient | SR-10, SR-11 |
| 6-year-old, no weight today | SR-12; with weight and a dose outside the mg/kg/day range → SR-13 |
| Adult, dose × frequency above the maximum daily dose for the age band | SR-14 |
| Same molecule twice, or already in current medications | SR-07 |
| Adult with liver disease recorded | SR-17 |
| 72-year-old | SR-15 |
| Online consultation | SR-18, SR-19 |
| Incomplete line | SR-20 |
| Allergy entered by the patient, not yet verified | SR-21 (label on the related alert) |
| Medicine typed as free text (not in the master) | SR-22 |
| Contraindicated and moderate interaction pairs, chosen by the clinical advisor from the licensed database | SR-04, SR-06 |

## Sign-off record
| Version | Date | Clinical advisor | Doctor (Dr. Gupta) | Notes |
|---|---|---|---|---|
| 0.1 | | | | Initial catalogue |
