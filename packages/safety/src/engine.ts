/**
 * The safety engine (PRD §6.5, docs/safety/safety-rule-catalogue.md): checks a
 * prescription against the patient's chart and the reference drug data, and returns one
 * finding per problem. It is pure — the API loads the chart and the drug facts, and the
 * server's result is final. Drug facts come only from `facts` (the licensed database; a
 * synthetic sample in development), never from this file.
 */
import { parseFrequency, type DoseStep } from '@dhc/domain';
import { getSafetyRule, type SafetyRuleId, type Severity } from './catalogue';

export type DrugRisk = 'caution' | 'contraindicated';
export type TelemedicineList = 'o' | 'a' | 'b' | 'prohibited';
export type InteractionSeverity = 'contraindicated' | 'major' | 'moderate' | 'minor';
export type ChartSource = 'doctor' | 'patient';
export type ConsultationMode = 'in_person' | 'audio' | 'video';

export interface MoleculeFacts {
  id: string;
  name: string;
  drugClass: string | null;
  pregnancy: DrugRisk | null;
  pregnancyOverridable: boolean;
  lactation: DrugRisk | null;
  weightBased: boolean;
  childMinMgPerKgDay: number | null;
  childMaxMgPerKgDay: number | null;
  childDoseOverridable: boolean;
  maxDailyMg: number | null;
  maxDoseOverridable: boolean;
  olderAdultCaution: boolean;
  renalAdjustment: boolean;
  hepaticCaution: boolean;
  telemedicineList: TelemedicineList | null;
}

export interface InteractionFact {
  moleculeAId: string;
  moleculeBId: string;
  severity: InteractionSeverity;
  overridable: boolean;
  note: string | null;
}

export interface CrossSensitivityFact {
  allergyClass: string;
  drugClass: string;
  note: string | null;
}

export interface ConditionRuleFact {
  moleculeId: string | null;
  drugClass: string | null;
  conditionCodes: string[];
  conditionTerms: string[];
  note: string;
}

export interface DrugFacts {
  version: string;
  /** Every molecule a line, an allergy or a current medicine may refer to. */
  molecules: MoleculeFacts[];
  interactions: InteractionFact[];
  crossSensitivities: CrossSensitivityFact[];
  conditionRules: ConditionRuleFact[];
}

export interface SafetyLine {
  id: string;
  name: string;
  medicineId: string | null;
  ingredients: { moleculeId: string; strengthMg: number | null; per: 'unit' | 'ml' | null }[];
  steps: DoseStep[];
}

export interface SafetyInput {
  patient: {
    ageYears: number | null;
    /** Recorded at this visit; null when not taken today. */
    weightKg: number | null;
    pregnancy: 'pregnant' | 'breastfeeding' | 'not_pregnant' | null;
  };
  allergies: { id: string; substance: string; source: ChartSource }[];
  conditions: { id: string; name: string; icd10Code: string | null; source: ChartSource }[];
  currentMedications: { id: string; name: string; source: ChartSource }[];
  consultation: { mode: ConsultationMode; followUp: boolean };
  lines: SafetyLine[];
  facts: DrugFacts;
}

export type FindingParams = Record<string, string | number>;

export interface SafetyFinding {
  /** Rule, line and subject; the same problem keeps the same key across saves. */
  key: string;
  ruleId: SafetyRuleId;
  severity: Severity;
  itemId: string | null;
  /** A block the drug database allows overriding with a reason. Always false otherwise. */
  overridable: boolean;
  /** Whether acknowledging (a warning) or overriding (a block) needs a typed reason. */
  reasonRequired: boolean;
  params: FindingParams;
  /** English, for the safety log; screens build their own text from `ruleId` and `params`. */
  message: string;
  /** SR-21: based on a patient-reported allergy, condition or medicine not yet verified. */
  unverified: boolean;
}

/** Children below this age need weight-based checks (SR-12, SR-13). */
export const CHILD_UNDER_YEARS = 12;
/** Older adults from this age get the potentially-inappropriate-medicine note (SR-15). */
export const OLDER_ADULT_FROM_YEARS = 65;

const KIDNEY = { codes: ['N17', 'N18', 'N19'], terms: ['kidney', 'renal', 'ckd'] };
const LIVER = {
  codes: [
    'B15',
    'B16',
    'B17',
    'B18',
    'B19',
    'K70',
    'K71',
    'K72',
    'K73',
    'K74',
    'K75',
    'K76',
    'K77',
  ],
  terms: ['liver', 'hepatic', 'hepatitis', 'cirrhosis'],
};

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether `text` mentions `term` as a word (case-insensitive; a plural "s" is allowed). */
export function mentions(text: string, term: string): boolean {
  const t = term.trim();
  if (!t) return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escape(t)}s?(?=$|[^\\p{L}\\p{N}])`, 'iu').test(text);
}

function matchesCondition(
  condition: { name: string; icd10Code: string | null },
  codes: string[],
  terms: string[],
): boolean {
  const code = condition.icd10Code?.toUpperCase().replace('.', '') ?? '';
  return (
    (code !== '' && codes.some((c) => code.startsWith(c.toUpperCase()))) ||
    terms.some((t) => mentions(condition.name, t))
  );
}

const COUNT_UNITS = /^(tablets?|tabs?|capsules?|caps?|sachets?|drops?|puffs?)$/i;

/** "1 tablet", "½ tablet", "2.5 ml", "500 mg", "1 g", "2" → quantity and unit. */
function parseDose(dose: string): { qty: number; unit: string } | null {
  const m = /^\s*(\d+(?:\.\d+)?|½|\d+\/\d+)\s*(.*)$/.exec(dose);
  if (!m) return null;
  const raw = m[1]!;
  const qty =
    raw === '½'
      ? 0.5
      : raw.includes('/')
        ? Number(raw.split('/')[0]) / Number(raw.split('/')[1])
        : Number(raw);
  if (!Number.isFinite(qty) || qty <= 0) return null;
  return { qty, unit: m[2]!.trim().toLowerCase() };
}

const slotValue = (v: string) => (v === '½' ? 0.5 : Number(v));

/**
 * Milligrams of one ingredient per dosing day for a step, or null when it cannot be
 * worked out (as-needed doses, free-text frequencies, creams, unknown strengths).
 */
function stepDailyMg(
  step: DoseStep,
  ingredient: SafetyLine['ingredients'][number],
  singleIngredient: boolean,
): number | null {
  const dose = parseDose(step.dose);
  if (!dose) return null;
  const freq = parseFrequency(step.frequency);
  let units: number;
  const countable = dose.unit === '' || COUNT_UNITS.test(dose.unit);
  if (freq.kind === 'slots') {
    const values = freq.values.map(slotValue);
    const sum = values.reduce((a, b) => a + b, 0);
    // Slot amounts other than 1 are the count itself for tablets ("2-0-1" = 3 tablets);
    // for a measured dose they multiply it ("500 mg" with 2-0-1 = 1500 mg).
    const amounts = values.some((v) => v !== 0 && v !== 1);
    units = countable && amounts ? sum : dose.qty * sum;
  } else if (freq.kind === 'perDay') units = dose.qty * freq.times;
  else if (['hs', 'stat', 'weekly', 'monthly', 'alternate'].includes(freq.kind)) units = dose.qty;
  else return null;

  if (countable) {
    return ingredient.per === 'unit' && ingredient.strengthMg !== null
      ? units * ingredient.strengthMg
      : null;
  }
  if (/^(ml|millilitres?)$/.test(dose.unit) || /^teaspoons?$/.test(dose.unit)) {
    const ml = /^teaspoons?$/.test(dose.unit) ? units * 5 : units;
    return ingredient.per === 'ml' && ingredient.strengthMg !== null
      ? ml * ingredient.strengthMg
      : null;
  }
  // A weight dose ("500 mg") is only unambiguous for a single-molecule medicine.
  if (!singleIngredient) return null;
  if (dose.unit === 'mg') return units;
  if (dose.unit === 'g') return units * 1000;
  if (dose.unit === 'mcg' || dose.unit === 'µg') return units / 1000;
  return null;
}

/** Highest daily milligrams across a line's steps (steps follow one another). */
function lineDailyMg(
  line: SafetyLine,
  ingredient: SafetyLine['ingredients'][number],
): number | null {
  const values = line.steps
    .map((s) => stepDailyMg(s, ingredient, line.ingredients.length === 1))
    .filter((v): v is number => v !== null);
  return values.length > 0 ? Math.max(...values) : null;
}

const round = (n: number, places = 1) => Math.round(n * 10 ** places) / 10 ** places;

/** Runs every rule and returns the findings, ordered by line then rule. */
export function checkPrescription(input: SafetyInput): SafetyFinding[] {
  const { patient, consultation, facts } = input;
  const molecules = new Map(facts.molecules.map((m) => [m.id, m]));
  const findings: SafetyFinding[] = [];
  const add = (
    ruleId: SafetyRuleId,
    line: SafetyLine | null,
    subject: string,
    params: FindingParams,
    message: string,
    opts: { overridable?: boolean; unverified?: boolean } = {},
  ) => {
    const rule = getSafetyRule(ruleId);
    const overridable = rule.severity === 'block' && (opts.overridable ?? false);
    const reasonRequired =
      rule.reasonRequired === 'yes' || (rule.reasonRequired === 'if_overridable' && overridable);
    findings.push({
      key: `${ruleId}:${line?.id ?? '*'}:${subject}`,
      ruleId,
      severity: rule.severity,
      itemId: line?.id ?? null,
      overridable,
      reasonRequired,
      params,
      message,
      unverified: opts.unverified ?? false,
    });
  };

  // What the chart's free text refers to: molecules and classes named in each allergy,
  // and molecules named in each current medicine.
  const allMolecules = facts.molecules;
  const knownClasses = [
    ...new Set(allMolecules.flatMap((m) => (m.drugClass ? [m.drugClass] : []))),
  ];
  const allergyHits = input.allergies.map((a) => {
    const named = allMolecules.filter((m) => mentions(a.substance, m.name));
    const classes = new Set([
      ...knownClasses.filter((c) => mentions(a.substance, c)),
      ...named.flatMap((m) => (m.drugClass ? [m.drugClass] : [])),
    ]);
    return { allergy: a, molecules: new Set(named.map((m) => m.id)), classes };
  });
  const medicationHits = input.currentMedications.map((med) => ({
    med,
    molecules: allMolecules.filter((m) => mentions(med.name, m.name)),
  }));
  const kidneyDisease = input.conditions.filter((c) =>
    matchesCondition(c, KIDNEY.codes, KIDNEY.terms),
  );
  const liverDisease = input.conditions.filter((c) =>
    matchesCondition(c, LIVER.codes, LIVER.terms),
  );
  const interactionOf = (a: string, b: string) =>
    facts.interactions.find(
      (i) =>
        (i.moleculeAId === a && i.moleculeBId === b) ||
        (i.moleculeAId === b && i.moleculeBId === a),
    );
  const interactionRule = (s: InteractionSeverity): SafetyRuleId =>
    s === 'contraindicated' ? 'SR-04' : s === 'major' ? 'SR-05' : 'SR-06';

  const adult = patient.ageYears === null || patient.ageYears >= CHILD_UNDER_YEARS;
  const child = patient.ageYears !== null && patient.ageYears < CHILD_UNDER_YEARS;
  const online = consultation.mode !== 'in_person';

  // Daily totals per molecule across all lines, reported on the last line that has it.
  const totals = new Map<string, { mg: number; line: SafetyLine }>();
  for (const line of input.lines) {
    for (const ing of line.ingredients) {
      const mg = lineDailyMg(line, ing);
      if (mg === null) continue;
      const prev = totals.get(ing.moleculeId);
      totals.set(ing.moleculeId, { mg: (prev?.mg ?? 0) + mg, line });
    }
  }

  input.lines.forEach((line, index) => {
    // SR-20: every step needs a dose, a frequency and (except STAT) a duration.
    const missing = new Set<string>();
    for (const step of line.steps) {
      if (!step.dose.trim()) missing.add('dose');
      if (!step.frequency.trim()) missing.add('frequency');
      if (step.durationValue === null && parseFrequency(step.frequency).kind !== 'stat') {
        missing.add('duration');
      }
    }
    if (missing.size > 0) {
      const fields = [...missing].join(',');
      add(
        'SR-20',
        line,
        'line',
        { medicine: line.name, fields },
        `${line.name}: missing ${[...missing].join(', ')}.`,
      );
    }

    // SR-22: no molecules known, so the other checks cannot see this medicine.
    if (line.medicineId === null || line.ingredients.length === 0) {
      add(
        'SR-22',
        line,
        'line',
        { medicine: line.name },
        `${line.name} is not in the medicine list; safety checks are limited.`,
      );
    }

    const earlier = input.lines.slice(0, index);
    for (const ing of line.ingredients) {
      const m = molecules.get(ing.moleculeId);
      if (!m) continue;

      // SR-01 to SR-03: allergies.
      for (const hit of allergyHits) {
        const a = hit.allergy;
        const unverified = a.source === 'patient';
        const base = { medicine: line.name, molecule: m.name, allergy: a.substance };
        if (hit.molecules.has(m.id)) {
          add(
            'SR-01',
            line,
            `${a.id}:${m.id}`,
            base,
            `${m.name} matches the recorded allergy "${a.substance}".`,
            { unverified },
          );
        } else if (m.drugClass && hit.classes.has(m.drugClass)) {
          add(
            'SR-02',
            line,
            `${a.id}:${m.id}`,
            { ...base, drugClass: m.drugClass },
            `${m.name} is a ${m.drugClass}, the class of the recorded allergy "${a.substance}".`,
            { unverified },
          );
        } else if (m.drugClass) {
          const cross = facts.crossSensitivities.find(
            (c) => c.drugClass === m.drugClass && hit.classes.has(c.allergyClass),
          );
          if (cross) {
            add(
              'SR-03',
              line,
              `${a.id}:${m.id}`,
              { ...base, drugClass: m.drugClass, allergyClass: cross.allergyClass },
              `${m.name} (${m.drugClass}) can cross-react with the recorded ${cross.allergyClass} allergy "${a.substance}".`,
              { unverified },
            );
          }
        }
      }

      // SR-04 to SR-08 against earlier lines (each pair once, on the later line).
      for (const other of earlier) {
        for (const oi of other.ingredients) {
          const om = molecules.get(oi.moleculeId);
          if (!om) continue;
          const pair = {
            medicine: line.name,
            molecule: m.name,
            other: other.name,
            otherMolecule: om.name,
          };
          if (om.id === m.id) {
            add(
              'SR-07',
              line,
              `line:${other.id}:${m.id}`,
              pair,
              `${m.name} is also in ${other.name}.`,
            );
            continue;
          }
          const ix = interactionOf(m.id, om.id);
          if (ix) {
            add(
              interactionRule(ix.severity),
              line,
              `line:${other.id}:${om.id}:${m.id}`,
              { ...pair, severity: ix.severity, note: ix.note ?? '' },
              `${ix.severity} interaction: ${m.name} with ${om.name}${ix.note ? ` — ${ix.note}` : ''}`,
              { overridable: ix.overridable },
            );
          }
          if (m.drugClass && m.drugClass === om.drugClass) {
            add(
              'SR-08',
              line,
              `line:${other.id}:${om.id}:${m.id}`,
              { ...pair, drugClass: m.drugClass },
              `${m.name} and ${om.name} are both ${m.drugClass}.`,
            );
          }
        }
      }

      // The same checks against what the patient already takes.
      for (const { med, molecules: medMolecules } of medicationHits) {
        const unverified = med.source === 'patient';
        for (const om of medMolecules) {
          const pair = {
            medicine: line.name,
            molecule: m.name,
            other: med.name,
            otherMolecule: om.name,
          };
          if (om.id === m.id) {
            add(
              'SR-07',
              line,
              `med:${med.id}:${m.id}`,
              pair,
              `${m.name} is already taken (${med.name}).`,
              { unverified },
            );
            continue;
          }
          const ix = interactionOf(m.id, om.id);
          if (ix) {
            add(
              interactionRule(ix.severity),
              line,
              `med:${med.id}:${om.id}:${m.id}`,
              { ...pair, severity: ix.severity, note: ix.note ?? '' },
              `${ix.severity} interaction: ${m.name} with ${om.name} (${med.name})${ix.note ? ` — ${ix.note}` : ''}`,
              { overridable: ix.overridable, unverified },
            );
          }
          if (m.drugClass && m.drugClass === om.drugClass) {
            add(
              'SR-08',
              line,
              `med:${med.id}:${om.id}:${m.id}`,
              { ...pair, drugClass: m.drugClass },
              `${m.name} and ${om.name} (${med.name}) are both ${m.drugClass}.`,
              { unverified },
            );
          }
        }
      }

      // SR-09: drug–condition rules.
      for (const rule of facts.conditionRules) {
        const applies = rule.moleculeId ? rule.moleculeId === m.id : rule.drugClass === m.drugClass;
        if (!applies) continue;
        for (const c of input.conditions) {
          if (!matchesCondition(c, rule.conditionCodes, rule.conditionTerms)) continue;
          add(
            'SR-09',
            line,
            `${c.id}:${m.id}`,
            { medicine: line.name, molecule: m.name, condition: c.name, note: rule.note },
            `${m.name} with ${c.name}: ${rule.note}`,
            { unverified: c.source === 'patient' },
          );
        }
      }

      // SR-10, SR-11: pregnancy and breastfeeding (status from today's vitals).
      if (patient.pregnancy === 'pregnant' && m.pregnancy) {
        if (m.pregnancy === 'contraindicated') {
          add(
            'SR-10',
            line,
            m.id,
            { medicine: line.name, molecule: m.name },
            `${m.name} is contraindicated in pregnancy.`,
            {
              overridable: m.pregnancyOverridable,
            },
          );
        } else {
          add(
            'SR-11',
            line,
            `pregnant:${m.id}`,
            { medicine: line.name, molecule: m.name, status: 'pregnant' },
            `Use ${m.name} with caution in pregnancy.`,
          );
        }
      }
      if (patient.pregnancy === 'breastfeeding' && m.lactation) {
        add(
          'SR-11',
          line,
          `breastfeeding:${m.id}`,
          { medicine: line.name, molecule: m.name, status: 'breastfeeding', risk: m.lactation },
          m.lactation === 'contraindicated'
            ? `${m.name} is not recommended while breastfeeding.`
            : `Use ${m.name} with caution while breastfeeding.`,
        );
      }

      // SR-12: a child's weight-based medicine needs today's weight.
      if (child && m.weightBased && patient.weightKg === null) {
        add(
          'SR-12',
          line,
          m.id,
          { medicine: line.name, molecule: m.name },
          `${m.name} is dosed by weight; record today's weight.`,
        );
      }

      // SR-15 to SR-17.
      if (
        patient.ageYears !== null &&
        patient.ageYears >= OLDER_ADULT_FROM_YEARS &&
        m.olderAdultCaution
      ) {
        add(
          'SR-15',
          line,
          m.id,
          { medicine: line.name, molecule: m.name },
          `${m.name} may be inappropriate for older adults.`,
        );
      }
      if (m.renalAdjustment) {
        for (const c of kidneyDisease) {
          add(
            'SR-16',
            line,
            `${c.id}:${m.id}`,
            { medicine: line.name, molecule: m.name, condition: c.name },
            `${m.name} may need a dose adjustment for ${c.name}.`,
            { unverified: c.source === 'patient' },
          );
        }
      }
      if (m.hepaticCaution) {
        for (const c of liverDisease) {
          add(
            'SR-17',
            line,
            `${c.id}:${m.id}`,
            { medicine: line.name, molecule: m.name, condition: c.name },
            `Use ${m.name} with caution in ${c.name}.`,
            { unverified: c.source === 'patient' },
          );
        }
      }

      // SR-18, SR-19: telemedicine lists in an audio or video consultation.
      if (online && m.telemedicineList === 'prohibited') {
        add(
          'SR-18',
          line,
          m.id,
          { medicine: line.name, molecule: m.name },
          `${m.name} cannot be prescribed in an online consultation.`,
        );
      }
      if (online && m.telemedicineList === 'b' && !consultation.followUp) {
        add(
          'SR-19',
          line,
          m.id,
          { medicine: line.name, molecule: m.name },
          `${m.name} (List B) is only for an online follow-up.`,
        );
      }
    }
  });

  // SR-13, SR-14: daily totals per molecule, on the last line that has the molecule.
  for (const [moleculeId, { mg, line }] of totals) {
    const m = molecules.get(moleculeId);
    if (!m) continue;
    if (
      child &&
      patient.weightKg !== null &&
      m.childMinMgPerKgDay !== null &&
      m.childMaxMgPerKgDay !== null
    ) {
      const perKg = round(mg / patient.weightKg);
      if (perKg < m.childMinMgPerKgDay || perKg > m.childMaxMgPerKgDay) {
        add(
          'SR-13',
          line,
          `${m.id}:${perKg}`,
          {
            medicine: line.name,
            molecule: m.name,
            mgPerKgDay: perKg,
            min: m.childMinMgPerKgDay,
            max: m.childMaxMgPerKgDay,
            direction: perKg > m.childMaxMgPerKgDay ? 'above' : 'below',
          },
          `${m.name}: ${perKg} mg/kg/day is outside ${m.childMinMgPerKgDay}–${m.childMaxMgPerKgDay} mg/kg/day.`,
          { overridable: m.childDoseOverridable },
        );
      }
    }
    if (adult && m.maxDailyMg !== null && mg > m.maxDailyMg) {
      const total = round(mg, 2);
      add(
        'SR-14',
        line,
        `${m.id}:${total}`,
        { medicine: line.name, molecule: m.name, dailyMg: total, maxMg: m.maxDailyMg },
        `${m.name}: ${total} mg a day is above the maximum of ${m.maxDailyMg} mg.`,
        { overridable: m.maxDoseOverridable },
      );
    }
  }

  const order = new Map(input.lines.map((l, i) => [l.id, i]));
  return findings.sort(
    (a, b) =>
      (order.get(a.itemId ?? '') ?? -1) - (order.get(b.itemId ?? '') ?? -1) ||
      a.ruleId.localeCompare(b.ruleId) ||
      a.key.localeCompare(b.key),
  );
}
