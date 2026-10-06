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
- Every override records doctor, reason, time and the database version used.
- Monthly alert review: alerts shown vs accepted vs overridden, to tune non-critical visibility and reduce alert fatigue.

## Test pack (minimum cases per rule)
Each rule needs at least one positive case (fires) and one negative case (does not fire), using synthetic personas:

| Persona (synthetic) | Exercises |
|---|---|
| Adult with recorded penicillin allergy | SR-01/02 (amoxicillin), SR-03 (cefixime) |
| Adult on warfarin | SR-05 (with an NSAID such as ibuprofen), SR-08 |
| Adult with chronic kidney disease | SR-09, SR-16 |
| Adult with asthma | SR-09 (non-selective beta-blocker) |
| Pregnant patient | SR-10, SR-11 |
| 6-year-old, no weight today | SR-12; with weight → SR-13 |
| 72-year-old | SR-15 |
| Online consultation | SR-18, SR-19 |
| Incomplete line | SR-20 |

## Sign-off record
| Version | Date | Clinical advisor | Doctor (Dr. Gupta) | Notes |
|---|---|---|---|---|
| 0.1 | | | | Initial catalogue |
