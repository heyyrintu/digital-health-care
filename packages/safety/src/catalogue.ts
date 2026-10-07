/**
 * Safety rule catalogue — metadata only, mirroring docs/safety/safety-rule-catalogue.md.
 *
 * Status: DRAFT. No rule may go live before clinical sign-off. This file holds no drug
 * facts (interactions, doses, pregnancy data): those come from the licensed drug
 * database. Any change here must change the catalogue document in the same pull request.
 */
export type Severity = 'block' | 'warn' | 'info';

/** The "Reason required" column, kept verbatim rather than reinterpreted. */
export type ReasonRequired =
  'override_not_allowed' | 'never' | 'if_overridable' | 'yes' | 'no' | 'not_applicable';

/** The "Clinic can tune" column. */
export type ClinicTuning = 'no' | 'visibility_only';

export interface SafetyRule {
  id: `SR-${string}`;
  title: string;
  severity: Severity;
  reasonRequired: ReasonRequired;
  clinicTuning: ClinicTuning;
}

export const SAFETY_RULES = [
  {
    id: 'SR-01',
    title: 'Allergy — direct molecule match',
    severity: 'block',
    reasonRequired: 'override_not_allowed',
    clinicTuning: 'no',
  },
  {
    id: 'SR-02',
    title: 'Allergy — same drug class',
    severity: 'block',
    reasonRequired: 'override_not_allowed',
    clinicTuning: 'no',
  },
  {
    id: 'SR-03',
    title: 'Allergy — cross-sensitivity',
    severity: 'warn',
    reasonRequired: 'yes',
    clinicTuning: 'no',
  },
  {
    id: 'SR-04',
    title: 'Drug–drug interaction: contraindicated',
    severity: 'block',
    reasonRequired: 'if_overridable',
    clinicTuning: 'no',
  },
  {
    id: 'SR-05',
    title: 'Drug–drug interaction: major',
    severity: 'warn',
    reasonRequired: 'yes',
    clinicTuning: 'no',
  },
  {
    id: 'SR-06',
    title: 'Drug–drug interaction: moderate / minor',
    severity: 'info',
    reasonRequired: 'no',
    clinicTuning: 'visibility_only',
  },
  {
    id: 'SR-07',
    title: 'Duplicate molecule',
    severity: 'warn',
    reasonRequired: 'no',
    clinicTuning: 'no',
  },
  {
    id: 'SR-08',
    title: 'Duplicate therapeutic class',
    severity: 'warn',
    reasonRequired: 'no',
    clinicTuning: 'visibility_only',
  },
  {
    id: 'SR-09',
    title: 'Drug–condition',
    severity: 'warn',
    reasonRequired: 'yes',
    clinicTuning: 'no',
  },
  {
    id: 'SR-10',
    title: 'Pregnancy — contraindicated',
    severity: 'block',
    reasonRequired: 'if_overridable',
    clinicTuning: 'no',
  },
  {
    id: 'SR-11',
    title: 'Pregnancy / breastfeeding — caution',
    severity: 'warn',
    reasonRequired: 'no',
    clinicTuning: 'no',
  },
  {
    id: 'SR-12',
    title: 'Child (<12 y) weight-based drug with no weight recorded today',
    severity: 'block',
    reasonRequired: 'no',
    clinicTuning: 'no',
  },
  {
    id: 'SR-13',
    title: 'Child dose outside mg/kg/day range',
    severity: 'block',
    reasonRequired: 'if_overridable',
    clinicTuning: 'no',
  },
  {
    id: 'SR-14',
    title: 'Maximum daily dose exceeded',
    severity: 'block',
    reasonRequired: 'if_overridable',
    clinicTuning: 'no',
  },
  {
    id: 'SR-15',
    title: 'Older adult (65+) potentially inappropriate medicine',
    severity: 'info',
    reasonRequired: 'no',
    clinicTuning: 'visibility_only',
  },
  {
    id: 'SR-16',
    title: 'Kidney adjustment needed',
    severity: 'warn',
    reasonRequired: 'no',
    clinicTuning: 'no',
  },
  {
    id: 'SR-17',
    title: 'Liver caution',
    severity: 'warn',
    reasonRequired: 'no',
    clinicTuning: 'no',
  },
  {
    id: 'SR-18',
    title: 'Telemedicine: Prohibited list in online consultation',
    severity: 'block',
    reasonRequired: 'never',
    clinicTuning: 'no',
  },
  {
    id: 'SR-19',
    title: 'Telemedicine: List B outside a follow-up',
    severity: 'warn',
    reasonRequired: 'yes',
    clinicTuning: 'no',
  },
  {
    id: 'SR-20',
    title: 'Completeness: missing dose, frequency or duration',
    severity: 'block',
    reasonRequired: 'never',
    clinicTuning: 'no',
  },
  {
    id: 'SR-21',
    title: 'Unverified patient-reported data used',
    severity: 'info',
    reasonRequired: 'not_applicable',
    clinicTuning: 'no',
  },
  {
    id: 'SR-22',
    title: 'Free-text medicine (not in master)',
    severity: 'warn',
    reasonRequired: 'no',
    clinicTuning: 'no',
  },
] as const satisfies readonly SafetyRule[];

export type SafetyRuleId = (typeof SAFETY_RULES)[number]['id'];

/** Rules that settings can never disable or downgrade (catalogue "Behaviour rules"). */
export const LOCKED_RULE_IDS: readonly SafetyRuleId[] = [
  'SR-01',
  'SR-02',
  'SR-04',
  'SR-10',
  'SR-12',
  'SR-18',
  'SR-20',
];

export function getSafetyRule(id: SafetyRuleId): SafetyRule {
  const rule = SAFETY_RULES.find((r) => r.id === id);
  if (!rule) throw new Error(`Unknown safety rule ${id}`);
  return rule;
}

export function isLockedRule(id: SafetyRuleId): boolean {
  return LOCKED_RULE_IDS.includes(id);
}
