/**
 * The catalogue's test pack: for every rule, a synthetic persona where it fires and the
 * same persona with the trigger removed. Drug facts here are a test fixture, not clinical
 * data.
 */
import type { DoseStep } from '@dhc/domain';
import { describe, expect, it } from 'vitest';
import {
  checkPrescription,
  mentions,
  type DrugFacts,
  type MoleculeFacts,
  type SafetyInput,
  type SafetyLine,
} from './index';

const molecule = (
  id: string,
  name: string,
  drugClass: string,
  over: Partial<MoleculeFacts> = {},
): MoleculeFacts => ({
  id,
  name,
  drugClass,
  pregnancy: null,
  pregnancyOverridable: false,
  lactation: null,
  weightBased: false,
  childMinMgPerKgDay: null,
  childMaxMgPerKgDay: null,
  childDoseOverridable: true,
  maxDailyMg: null,
  maxDoseOverridable: true,
  olderAdultCaution: false,
  renalAdjustment: false,
  hepaticCaution: false,
  telemedicineList: null,
  ...over,
});

const M = {
  para: molecule('m-para', 'Paracetamol', 'Analgesic', {
    weightBased: true,
    childMinMgPerKgDay: 20,
    childMaxMgPerKgDay: 75,
    maxDailyMg: 4000,
    hepaticCaution: true,
  }),
  ibu: molecule('m-ibu', 'Ibuprofen', 'NSAID', {
    pregnancy: 'caution',
    olderAdultCaution: true,
    renalAdjustment: true,
  }),
  diclo: molecule('m-diclo', 'Diclofenac', 'NSAID'),
  etori: molecule('m-etori', 'Etoricoxib', 'NSAID', { pregnancy: 'contraindicated' }),
  amox: molecule('m-amox', 'Amoxicillin', 'Penicillin'),
  ampi: molecule('m-ampi', 'Ampicillin', 'Penicillin'),
  cefix: molecule('m-cefix', 'Cefixime', 'Cephalosporin'),
  warf: molecule('m-warf', 'Warfarin', 'Anticoagulant'),
  simva: molecule('m-simva', 'Simvastatin', 'Statin'),
  clari: molecule('m-clari', 'Clarithromycin', 'Macrolide'),
  tram: molecule('m-tram', 'Tramadol', 'Opioid analgesic', { telemedicineList: 'prohibited' }),
  preg: molecule('m-pregab', 'Pregabalin', 'Gabapentinoid', { telemedicineList: 'b' }),
  cet: molecule('m-cet', 'Cetirizine', 'Antihistamine', { lactation: 'caution' }),
  prop: molecule('m-prop', 'Propranolol', 'Non-selective beta-blocker'),
};

const facts: DrugFacts = {
  version: 'test',
  molecules: Object.values(M),
  interactions: [
    {
      moleculeAId: 'm-clari',
      moleculeBId: 'm-simva',
      severity: 'contraindicated',
      overridable: false,
      note: null,
    },
    {
      moleculeAId: 'm-ibu',
      moleculeBId: 'm-warf',
      severity: 'major',
      overridable: false,
      note: 'Bleeding.',
    },
    {
      moleculeAId: 'm-para',
      moleculeBId: 'm-warf',
      severity: 'moderate',
      overridable: false,
      note: null,
    },
  ],
  crossSensitivities: [{ allergyClass: 'Penicillin', drugClass: 'Cephalosporin', note: null }],
  conditionRules: [
    {
      moleculeId: null,
      drugClass: 'NSAID',
      conditionCodes: ['N18'],
      conditionTerms: ['kidney', 'ckd'],
      note: 'Kidney.',
    },
    {
      moleculeId: null,
      drugClass: 'Non-selective beta-blocker',
      conditionCodes: ['J45'],
      conditionTerms: ['asthma'],
      note: 'Bronchospasm.',
    },
  ],
};

const step = (over: Partial<DoseStep> = {}): DoseStep => ({
  dose: '1 tablet',
  frequency: '1-0-1',
  durationValue: 5,
  durationUnit: 'days',
  ...over,
});

let n = 0;
const line = (
  m: MoleculeFacts | null,
  over: Partial<SafetyLine> & { mg?: number; per?: 'unit' | 'ml' } = {},
): SafetyLine => {
  n += 1;
  const { mg = 500, per = 'unit', ...rest } = over;
  return {
    id: `line-${n}`,
    name: m ? `${m.name} ${mg}` : 'Herbal tonic',
    medicineId: m ? `med-${m.id}` : null,
    ingredients: m ? [{ moleculeId: m.id, strengthMg: mg, per }] : [],
    steps: [step()],
    ...rest,
  };
};

const input = (over: Partial<SafetyInput>): SafetyInput => ({
  patient: { ageYears: 40, weightKg: 70, pregnancy: null },
  allergies: [],
  conditions: [],
  currentMedications: [],
  consultation: { mode: 'in_person', followUp: false },
  lines: [],
  facts,
  ...over,
});

const rules = (i: SafetyInput) => checkPrescription(i).map((f) => f.ruleId);
const find = (i: SafetyInput, ruleId: string) =>
  checkPrescription(i).find((f) => f.ruleId === ruleId);

const allergy = (substance: string, source: 'doctor' | 'patient' = 'doctor') => ({
  id: `a-${substance}`,
  substance,
  source,
});
const condition = (
  name: string,
  icd10Code: string | null = null,
  source: 'doctor' | 'patient' = 'doctor',
) => ({
  id: `c-${name}`,
  name,
  icd10Code,
  source,
});

describe('mentions', () => {
  it('matches whole words, case-insensitively, with an optional plural', () => {
    expect(mentions('Penicillins (rash)', 'penicillin')).toBe(true);
    expect(mentions('Amoxicillin', 'Amoxicillin')).toBe(true);
    expect(mentions('Paracetamolx', 'Paracetamol')).toBe(false);
    expect(mentions('warfarin 5 mg', 'Warfarin')).toBe(true);
  });
});

describe('allergies (SR-01 to SR-03)', () => {
  const penicillin = [allergy('Penicillin')];

  it('SR-01 blocks a molecule named in an allergy, with no override', () => {
    const f = find(input({ allergies: [allergy('Amoxicillin')], lines: [line(M.amox)] }), 'SR-01');
    expect(f).toMatchObject({ severity: 'block', overridable: false, reasonRequired: false });
    expect(
      rules(input({ allergies: [allergy('Amoxicillin')], lines: [line(M.para)] })),
    ).not.toContain('SR-01');
  });

  it('SR-02 blocks the same class: penicillin allergy with amoxicillin', () => {
    expect(rules(input({ allergies: penicillin, lines: [line(M.amox)] }))).toEqual(['SR-02']);
    // An allergy to one penicillin covers the class too.
    expect(rules(input({ allergies: [allergy('Ampicillin')], lines: [line(M.amox)] }))).toEqual([
      'SR-02',
    ]);
    expect(rules(input({ lines: [line(M.amox)] }))).toEqual([]);
  });

  it('SR-03 warns of cross-sensitivity: penicillin allergy with cefixime, with a reason', () => {
    const f = find(input({ allergies: penicillin, lines: [line(M.cefix)] }), 'SR-03');
    expect(f).toMatchObject({ severity: 'warn', reasonRequired: true });
    expect(rules(input({ allergies: [allergy('Sulfa')], lines: [line(M.cefix)] }))).toEqual([]);
  });

  it('SR-21 labels alerts from a patient-reported allergy as unverified', () => {
    expect(
      find(input({ allergies: [allergy('Penicillin', 'patient')], lines: [line(M.amox)] }), 'SR-02')
        ?.unverified,
    ).toBe(true);
    expect(find(input({ allergies: penicillin, lines: [line(M.amox)] }), 'SR-02')?.unverified).toBe(
      false,
    );
  });
});

describe('interactions and duplicates (SR-04 to SR-08)', () => {
  it('SR-04 blocks a contraindicated pair, overridable only if the database says so', () => {
    const f = find(input({ lines: [line(M.simva, { mg: 20 }), line(M.clari)] }), 'SR-04');
    expect(f).toMatchObject({ severity: 'block', overridable: false });
    const allowing: DrugFacts = {
      ...facts,
      interactions: [{ ...facts.interactions[0]!, overridable: true }],
    };
    expect(
      find(input({ facts: allowing, lines: [line(M.simva, { mg: 20 }), line(M.clari)] }), 'SR-04'),
    ).toMatchObject({
      overridable: true,
      reasonRequired: true,
    });
    expect(rules(input({ lines: [line(M.simva, { mg: 20 })] }))).toEqual([]);
  });

  it('SR-05 warns of a major interaction with a current medicine (warfarin + ibuprofen)', () => {
    const onWarfarin = [{ id: 'cm-1', name: 'Warfarin 5 mg', source: 'doctor' as const }];
    const f = find(
      input({ currentMedications: onWarfarin, lines: [line(M.ibu, { mg: 400 })] }),
      'SR-05',
    );
    expect(f).toMatchObject({
      severity: 'warn',
      reasonRequired: true,
      params: { other: 'Warfarin 5 mg' },
    });
    expect(rules(input({ lines: [line(M.ibu, { mg: 400 })] }))).toEqual([]);
  });

  it('SR-06 notes a moderate interaction between two lines', () => {
    expect(find(input({ lines: [line(M.warf, { mg: 5 }), line(M.para)] }), 'SR-06')).toMatchObject({
      severity: 'info',
    });
    expect(rules(input({ lines: [line(M.warf, { mg: 5 }), line(M.amox)] }))).toEqual([]);
  });

  it('SR-07 warns of the same molecule twice, in lines or current medicines', () => {
    expect(rules(input({ lines: [line(M.para), line(M.para, { mg: 650 })] }))).toContain('SR-07');
    expect(
      rules(
        input({
          currentMedications: [{ id: 'cm', name: 'Paracetamol', source: 'doctor' }],
          lines: [line(M.para)],
        }),
      ),
    ).toContain('SR-07');
    expect(rules(input({ lines: [line(M.para), line(M.amox)] }))).not.toContain('SR-07');
  });

  it('SR-08 warns of two medicines in one class (two NSAIDs)', () => {
    expect(
      rules(input({ lines: [line(M.ibu, { mg: 400 }), line(M.diclo, { mg: 50 })] })),
    ).toContain('SR-08');
    expect(rules(input({ lines: [line(M.ibu, { mg: 400 }), line(M.para)] }))).not.toContain(
      'SR-08',
    );
  });
});

describe('conditions (SR-09, SR-16, SR-17)', () => {
  it('SR-09 warns with a reason for an NSAID with kidney disease, by code or name', () => {
    expect(
      find(
        input({
          conditions: [condition('Chronic kidney disease', 'N18.3')],
          lines: [line(M.ibu, { mg: 400 })],
        }),
        'SR-09',
      ),
    ).toMatchObject({
      severity: 'warn',
      reasonRequired: true,
    });
    expect(
      rules(input({ conditions: [condition('CKD stage 3')], lines: [line(M.diclo, { mg: 50 })] })),
    ).toContain('SR-09');
    expect(
      rules(
        input({
          conditions: [condition('Hypertension', 'I10')],
          lines: [line(M.ibu, { mg: 400 })],
        }),
      ),
    ).not.toContain('SR-09');
  });

  it('SR-09 warns for a non-selective beta-blocker with asthma', () => {
    expect(
      rules(input({ conditions: [condition('Asthma', 'J45')], lines: [line(M.prop, { mg: 40 })] })),
    ).toEqual(['SR-09']);
    expect(rules(input({ lines: [line(M.prop, { mg: 40 })] }))).toEqual([]);
  });

  it('SR-16 warns that a kidney-cleared medicine may need adjusting', () => {
    expect(
      rules(
        input({
          conditions: [condition('Chronic kidney disease', 'N18')],
          lines: [line(M.ibu, { mg: 400 })],
        }),
      ),
    ).toContain('SR-16');
    expect(rules(input({ lines: [line(M.ibu, { mg: 400 })] }))).not.toContain('SR-16');
  });

  it('SR-17 warns about liver disease, and SR-21 labels a patient-reported condition', () => {
    const f = find(
      input({ conditions: [condition('Fatty liver', null, 'patient')], lines: [line(M.para)] }),
      'SR-17',
    );
    expect(f).toMatchObject({ severity: 'warn', unverified: true });
    expect(rules(input({ conditions: [condition('Fatty liver')], lines: [line(M.amox)] }))).toEqual(
      [],
    );
  });
});

describe('pregnancy and breastfeeding (SR-10, SR-11)', () => {
  const pregnant = { ageYears: 28, weightKg: 60, pregnancy: 'pregnant' as const };

  it('SR-10 blocks a contraindicated medicine in pregnancy', () => {
    expect(
      find(input({ patient: pregnant, lines: [line(M.etori, { mg: 90 })] }), 'SR-10'),
    ).toMatchObject({
      severity: 'block',
      overridable: false,
    });
    expect(rules(input({ lines: [line(M.etori, { mg: 90 })] }))).toEqual([]);
  });

  it('SR-11 warns of caution in pregnancy and while breastfeeding', () => {
    expect(rules(input({ patient: pregnant, lines: [line(M.ibu, { mg: 400 })] }))).toEqual([
      'SR-11',
    ]);
    expect(
      rules(
        input({
          patient: { ...pregnant, pregnancy: 'breastfeeding' },
          lines: [line(M.cet, { mg: 10 })],
        }),
      ),
    ).toEqual(['SR-11']);
    expect(
      rules(
        input({
          patient: { ...pregnant, pregnancy: 'not_pregnant' },
          lines: [line(M.ibu, { mg: 400 })],
        }),
      ),
    ).toEqual([]);
  });
});

describe('children and doses (SR-12 to SR-14)', () => {
  const child = { ageYears: 6, weightKg: null, pregnancy: null };
  const syrup = (dose: string, frequency = '1-1-1') =>
    line(M.para, { mg: 50, per: 'ml', steps: [step({ dose, frequency })] });

  it('SR-12 blocks a weight-based medicine for a 6-year-old with no weight today', () => {
    expect(find(input({ patient: child, lines: [syrup('5 ml')] }), 'SR-12')).toMatchObject({
      severity: 'block',
      overridable: false,
    });
    expect(
      rules(input({ patient: { ...child, weightKg: 20 }, lines: [syrup('5 ml')] })),
    ).not.toContain('SR-12');
    expect(rules(input({ patient: child, lines: [line(M.cet, { mg: 10 })] }))).not.toContain(
      'SR-12',
    );
  });

  it('SR-13 blocks a child dose outside the mg/kg/day range', () => {
    const weighed = { ...child, weightKg: 20 };
    // 10 ml × 3 = 30 ml × 50 mg = 1500 mg / 20 kg = 75 → within range.
    expect(rules(input({ patient: weighed, lines: [syrup('10 ml')] }))).not.toContain('SR-13');
    // 20 ml × 4 = 4000 mg / 20 kg = 200 mg/kg/day → above.
    const f = find(input({ patient: weighed, lines: [syrup('20 ml', '1-1-1-1')] }), 'SR-13');
    expect(f).toMatchObject({ severity: 'block', overridable: true, reasonRequired: true });
    expect(f?.params).toMatchObject({ mgPerKgDay: 200, direction: 'above' });
  });

  it('SR-14 blocks a daily total above the maximum, summed across lines', () => {
    // 1000 mg × 4 = 4000 → at the maximum, allowed.
    const at = line(M.para, { mg: 1000, steps: [step({ frequency: 'QID' })] });
    expect(rules(input({ lines: [at] }))).toEqual([]);
    // Plus another paracetamol line → 5300 mg.
    const f = find(
      input({
        lines: [
          at,
          line(M.para, { mg: 650, steps: [step({ dose: '1 tablet', frequency: '1-0-1' })] }),
        ],
      }),
      'SR-14',
    );
    expect(f?.params).toMatchObject({ dailyMg: 5300, maxMg: 4000 });
    expect(f).toMatchObject({ overridable: true, reasonRequired: true });
    // Slot amounts count tablets: 2-2-2 of 1000 mg = 6000 mg.
    expect(
      rules(input({ lines: [line(M.para, { mg: 1000, steps: [step({ frequency: '2-2-2' })] })] })),
    ).toContain('SR-14');
    // As-needed doses have no daily total.
    expect(
      rules(
        input({
          lines: [
            line(M.para, { mg: 1000, steps: [step({ dose: '2 tablets', frequency: 'SOS' })] }),
          ],
        }),
      ),
    ).toEqual([]);
  });

  it('SR-14 keys the alert by the total, so a higher dose needs a new override', () => {
    // The same line (same ID) each time: only the total can change the key.
    const base = line(M.para, { mg: 1000, steps: [step({ frequency: '2-2-2' })] });
    const at = (frequency: string) =>
      find(input({ lines: [{ ...base, steps: [step({ frequency })] }] }), 'SR-14')?.key;
    expect(at('2-2-2')).toBeDefined();
    expect(at('2-2-2')).toBe(at('2-2-2'));
    expect(at('3-3-3')).not.toBe(at('2-2-2'));
  });

  it('gives weekly and monthly doses no daily total', () => {
    const weekly = line(M.para, {
      mg: 1000,
      steps: [step({ dose: '5 tablets', frequency: 'weekly' })],
    });
    expect(rules(input({ lines: [weekly] }))).toEqual([]);
    const child = { ageYears: 6, weightKg: 20, pregnancy: null };
    const monthly = line(M.para, {
      mg: 50,
      per: 'ml',
      steps: [step({ dose: '1 ml', frequency: 'monthly' })],
    });
    expect(rules(input({ patient: child, lines: [monthly] }))).toEqual([]);
  });
});

describe('older adults and telemedicine (SR-15, SR-18, SR-19)', () => {
  it('SR-15 notes a potentially inappropriate medicine at 72', () => {
    expect(
      rules(
        input({
          patient: { ageYears: 72, weightKg: 60, pregnancy: null },
          lines: [line(M.ibu, { mg: 400 })],
        }),
      ),
    ).toEqual(['SR-15']);
    expect(rules(input({ lines: [line(M.ibu, { mg: 400 })] }))).toEqual([]);
  });

  it('SR-18 blocks a prohibited medicine online, never overridable', () => {
    const video = { mode: 'video' as const, followUp: true };
    expect(
      find(input({ consultation: video, lines: [line(M.tram, { mg: 50 })] }), 'SR-18'),
    ).toMatchObject({ overridable: false });
    expect(rules(input({ lines: [line(M.tram, { mg: 50 })] }))).toEqual([]);
  });

  it('SR-19 warns of List B outside a follow-up', () => {
    const audio = { mode: 'audio' as const, followUp: false };
    expect(
      find(input({ consultation: audio, lines: [line(M.preg, { mg: 75 })] }), 'SR-19'),
    ).toMatchObject({ reasonRequired: true });
    expect(
      rules(
        input({ consultation: { ...audio, followUp: true }, lines: [line(M.preg, { mg: 75 })] }),
      ),
    ).toEqual([]);
  });
});

describe('completeness and free text (SR-20, SR-22)', () => {
  it('SR-20 blocks a line missing dose, frequency or duration (STAT needs no duration)', () => {
    const f = find(
      input({ lines: [line(M.para, { steps: [step({ dose: '', durationValue: null })] })] }),
      'SR-20',
    );
    expect(f).toMatchObject({
      severity: 'block',
      overridable: false,
      params: { fields: 'dose,duration' },
    });
    expect(
      rules(
        input({
          lines: [line(M.para, { steps: [step({ frequency: 'STAT', durationValue: null })] })],
        }),
      ),
    ).toEqual([]);
    expect(rules(input({ lines: [line(M.para)] }))).toEqual([]);
  });

  it('SR-22 warns that checks are limited for a free-text medicine', () => {
    expect(find(input({ lines: [line(null)] }), 'SR-22')).toMatchObject({
      severity: 'warn',
      reasonRequired: false,
    });
    expect(rules(input({ lines: [line(M.para)] }))).toEqual([]);
  });
});

describe('ordering', () => {
  it('lists findings by line, then rule', () => {
    const lines = [
      line(M.ibu, { mg: 400 }),
      line(M.diclo, { mg: 50, steps: [step({ dose: '' })] }),
    ];
    const found = checkPrescription(input({ conditions: [condition('CKD')], lines }));
    expect(found.map((f) => [f.itemId, f.ruleId])).toEqual([
      [lines[0]!.id, 'SR-09'],
      [lines[0]!.id, 'SR-16'],
      [lines[1]!.id, 'SR-08'],
      [lines[1]!.id, 'SR-09'],
      [lines[1]!.id, 'SR-20'],
    ]);
  });
});
