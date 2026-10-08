import type { Db } from './client.ts';

/**
 * A synthetic sample of the reference drug data for development and tests: generic
 * products with common Indian strengths (no brand names) and the drug facts the safety
 * engine reads. Production loads the licensed drug database instead, with Indian brand
 * mapping. The facts below are illustrative only, chosen to exercise each safety rule;
 * they are NOT clinical advice and must not be used to treat anyone.
 */
export const SAMPLE_DRUG_DATA_VERSION = 'synthetic-sample-2026.10.1';

type Risk = 'caution' | 'contraindicated';
interface MoleculeFacts {
  pregnancy?: Risk;
  pregnancyOverridable?: boolean;
  lactation?: Risk;
  weightBased?: boolean;
  /** mg per kg per day for children under 12. */
  child?: [min: number, max: number];
  childDoseOverridable?: boolean;
  /** Maximum mg per day from 12 years. */
  maxDailyMg?: number;
  maxDoseOverridable?: boolean;
  olderAdultCaution?: boolean;
  renalAdjustment?: boolean;
  hepaticCaution?: boolean;
  telemedicineList?: 'o' | 'a' | 'b' | 'prohibited';
}

const MOLECULES: [name: string, drugClass: string, facts: MoleculeFacts][] = [
  [
    'Paracetamol',
    'Analgesic and antipyretic',
    {
      weightBased: true,
      child: [20, 75],
      maxDailyMg: 4000,
      hepaticCaution: true,
      telemedicineList: 'o',
    },
  ],
  [
    'Ibuprofen',
    'NSAID',
    {
      pregnancy: 'caution',
      weightBased: true,
      child: [20, 40],
      maxDailyMg: 2400,
      olderAdultCaution: true,
      renalAdjustment: true,
      telemedicineList: 'o',
    },
  ],
  [
    'Diclofenac',
    'NSAID',
    { pregnancy: 'caution', maxDailyMg: 150, olderAdultCaution: true, renalAdjustment: true },
  ],
  ['Aceclofenac', 'NSAID', { maxDailyMg: 200, olderAdultCaution: true, renalAdjustment: true }],
  [
    'Etoricoxib',
    'NSAID',
    {
      pregnancy: 'contraindicated',
      maxDailyMg: 120,
      olderAdultCaution: true,
      renalAdjustment: true,
    },
  ],
  ['Naproxen', 'NSAID', { maxDailyMg: 1000, olderAdultCaution: true, renalAdjustment: true }],
  [
    'Tramadol',
    'Opioid analgesic',
    {
      maxDailyMg: 400,
      olderAdultCaution: true,
      renalAdjustment: true,
      hepaticCaution: true,
      telemedicineList: 'prohibited',
    },
  ],
  ['Pantoprazole', 'Proton pump inhibitor', { maxDailyMg: 80 }],
  ['Rabeprazole', 'Proton pump inhibitor', {}],
  [
    'Amoxicillin',
    'Penicillin',
    { weightBased: true, child: [25, 90], maxDailyMg: 3000, telemedicineList: 'o' },
  ],
  ['Clavulanic acid', 'Beta-lactamase inhibitor', {}],
  ['Cefixime', 'Cephalosporin', { weightBased: true, child: [6, 12], maxDailyMg: 400 }],
  ['Azithromycin', 'Macrolide', { weightBased: true, child: [5, 12], maxDailyMg: 500 }],
  [
    'Clarithromycin',
    'Macrolide',
    { weightBased: true, child: [7.5, 15], maxDailyMg: 1000, hepaticCaution: true },
  ],
  ['Cetirizine', 'Antihistamine', { lactation: 'caution', maxDailyMg: 10 }],
  [
    'Thiocolchicoside',
    'Muscle relaxant',
    { pregnancy: 'contraindicated', lactation: 'contraindicated', maxDailyMg: 16 },
  ],
  ['Calcium carbonate', 'Calcium supplement', {}],
  ['Cholecalciferol', 'Vitamin D', {}],
  [
    'Pregabalin',
    'Gabapentinoid',
    { maxDailyMg: 600, olderAdultCaution: true, renalAdjustment: true, telemedicineList: 'b' },
  ],
  ['Methylcobalamin', 'Vitamin B12', {}],
  ['Prednisolone', 'Corticosteroid', {}],
  ['Warfarin', 'Anticoagulant', { pregnancy: 'contraindicated' }],
  ['Simvastatin', 'Statin', { pregnancy: 'contraindicated', maxDailyMg: 40, hepaticCaution: true }],
  ['Metformin', 'Biguanide', { maxDailyMg: 2550, renalAdjustment: true }],
  ['Amlodipine', 'Calcium channel blocker', { maxDailyMg: 10 }],
  ['Ondansetron', 'Antiemetic', { maxDailyMg: 24 }],
  ['Propranolol', 'Non-selective beta-blocker', { pregnancy: 'caution', maxDailyMg: 320 }],
  ['Glucosamine', 'Supplement', {}],
];

/** [molecule, mg per dose unit or per ml, 'unit' | 'ml']; no strength for creams and IU. */
type Ingredient = [molecule: string, mg?: number, per?: 'unit' | 'ml'];
type Route = 'oral' | 'topical';
const MEDICINES: [
  name: string,
  composition: string,
  form: string,
  ingredients: Ingredient[],
  route?: Route,
][] = [
  ['Paracetamol 500', 'Paracetamol 500 mg', 'tablet', [['Paracetamol', 500, 'unit']]],
  ['Paracetamol 650', 'Paracetamol 650 mg', 'tablet', [['Paracetamol', 650, 'unit']]],
  ['Paracetamol syrup', 'Paracetamol 250 mg/5 ml', 'syrup', [['Paracetamol', 50, 'ml']]],
  ['Ibuprofen 400', 'Ibuprofen 400 mg', 'tablet', [['Ibuprofen', 400, 'unit']]],
  ['Ibuprofen syrup', 'Ibuprofen 100 mg/5 ml', 'syrup', [['Ibuprofen', 20, 'ml']]],
  ['Diclofenac 50', 'Diclofenac sodium 50 mg', 'tablet', [['Diclofenac', 50, 'unit']]],
  ['Diclofenac gel', 'Diclofenac diethylamine 1.16% w/w', 'gel', [['Diclofenac']], 'topical'],
  [
    'Aceclofenac + Paracetamol',
    'Aceclofenac 100 mg + Paracetamol 325 mg',
    'tablet',
    [
      ['Aceclofenac', 100, 'unit'],
      ['Paracetamol', 325, 'unit'],
    ],
  ],
  ['Etoricoxib 90', 'Etoricoxib 90 mg', 'tablet', [['Etoricoxib', 90, 'unit']]],
  ['Naproxen 500', 'Naproxen 500 mg', 'tablet', [['Naproxen', 500, 'unit']]],
  [
    'Tramadol + Paracetamol',
    'Tramadol 37.5 mg + Paracetamol 325 mg',
    'tablet',
    [
      ['Tramadol', 37.5, 'unit'],
      ['Paracetamol', 325, 'unit'],
    ],
  ],
  ['Pantoprazole 40', 'Pantoprazole 40 mg', 'tablet', [['Pantoprazole', 40, 'unit']]],
  ['Rabeprazole 20', 'Rabeprazole 20 mg', 'tablet', [['Rabeprazole', 20, 'unit']]],
  ['Amoxicillin 500', 'Amoxicillin 500 mg', 'capsule', [['Amoxicillin', 500, 'unit']]],
  [
    'Amoxicillin + Clavulanic acid 625',
    'Amoxicillin 500 mg + Clavulanic acid 125 mg',
    'tablet',
    [
      ['Amoxicillin', 500, 'unit'],
      ['Clavulanic acid', 125, 'unit'],
    ],
  ],
  ['Cefixime 200', 'Cefixime 200 mg', 'tablet', [['Cefixime', 200, 'unit']]],
  ['Azithromycin 500', 'Azithromycin 500 mg', 'tablet', [['Azithromycin', 500, 'unit']]],
  ['Clarithromycin 500', 'Clarithromycin 500 mg', 'tablet', [['Clarithromycin', 500, 'unit']]],
  ['Cetirizine 10', 'Cetirizine 10 mg', 'tablet', [['Cetirizine', 10, 'unit']]],
  ['Thiocolchicoside 4', 'Thiocolchicoside 4 mg', 'capsule', [['Thiocolchicoside', 4, 'unit']]],
  [
    'Calcium + Vitamin D3',
    'Calcium carbonate 1250 mg + Cholecalciferol 250 IU',
    'tablet',
    [['Calcium carbonate', 1250, 'unit'], ['Cholecalciferol']],
  ],
  ['Cholecalciferol 60000 IU', 'Cholecalciferol 60000 IU', 'sachet', [['Cholecalciferol']]],
  ['Pregabalin 75', 'Pregabalin 75 mg', 'capsule', [['Pregabalin', 75, 'unit']]],
  [
    'Methylcobalamin 1500',
    'Methylcobalamin 1500 mcg',
    'tablet',
    [['Methylcobalamin', 1.5, 'unit']],
  ],
  ['Prednisolone 10', 'Prednisolone 10 mg', 'tablet', [['Prednisolone', 10, 'unit']]],
  ['Warfarin 5', 'Warfarin 5 mg', 'tablet', [['Warfarin', 5, 'unit']]],
  ['Simvastatin 20', 'Simvastatin 20 mg', 'tablet', [['Simvastatin', 20, 'unit']]],
  ['Metformin 500', 'Metformin 500 mg', 'tablet', [['Metformin', 500, 'unit']]],
  ['Amlodipine 5', 'Amlodipine 5 mg', 'tablet', [['Amlodipine', 5, 'unit']]],
  ['Ondansetron 4', 'Ondansetron 4 mg', 'tablet', [['Ondansetron', 4, 'unit']]],
  ['Propranolol 40', 'Propranolol 40 mg', 'tablet', [['Propranolol', 40, 'unit']]],
  ['Glucosamine 500', 'Glucosamine sulphate 500 mg', 'tablet', [['Glucosamine', 500, 'unit']]],
];

type Severity = 'contraindicated' | 'major' | 'moderate' | 'minor';
const INTERACTIONS: [a: string, b: string, severity: Severity, note: string][] = [
  [
    'Simvastatin',
    'Clarithromycin',
    'contraindicated',
    'Raises statin levels; risk of muscle damage.',
  ],
  ['Warfarin', 'Ibuprofen', 'major', 'Higher bleeding risk.'],
  ['Warfarin', 'Diclofenac', 'major', 'Higher bleeding risk.'],
  ['Warfarin', 'Aceclofenac', 'major', 'Higher bleeding risk.'],
  ['Warfarin', 'Etoricoxib', 'major', 'Higher bleeding risk.'],
  ['Warfarin', 'Naproxen', 'major', 'Higher bleeding risk.'],
  ['Warfarin', 'Clarithromycin', 'major', 'May raise INR.'],
  ['Warfarin', 'Paracetamol', 'moderate', 'Regular use may raise INR.'],
  ['Warfarin', 'Azithromycin', 'moderate', 'May raise INR.'],
  ['Amlodipine', 'Simvastatin', 'moderate', 'Keep the simvastatin dose low.'],
  ['Tramadol', 'Ondansetron', 'moderate', 'May reduce pain relief.'],
  ['Prednisolone', 'Metformin', 'minor', 'May raise blood sugar.'],
];

const CROSS_SENSITIVITIES: [allergyClass: string, drugClass: string, note: string][] = [
  ['Penicillin', 'Cephalosporin', 'Some people allergic to penicillins react to cephalosporins.'],
];

/** [molecule or class, ICD-10 prefixes, terms in the condition name, note]. */
const CONDITION_RULES: [
  target: { molecule: string } | { drugClass: string },
  codes: string[],
  terms: string[],
  note: string,
][] = [
  [
    { drugClass: 'NSAID' },
    ['N17', 'N18', 'N19'],
    ['kidney', 'renal', 'ckd'],
    'NSAIDs can worsen kidney function.',
  ],
  [
    { drugClass: 'NSAID' },
    ['K25', 'K26', 'K27'],
    ['peptic ulcer', 'gastric ulcer', 'duodenal ulcer'],
    'NSAIDs can cause ulcer bleeding.',
  ],
  [
    { drugClass: 'Non-selective beta-blocker' },
    ['J45', 'J46'],
    ['asthma'],
    'Non-selective beta-blockers can trigger bronchospasm.',
  ],
  [
    { drugClass: 'Corticosteroid' },
    ['E10', 'E11', 'E13', 'E14'],
    ['diabetes'],
    'Steroids can raise blood sugar.',
  ],
];

/**
 * Loads the sample reference data, adding what is missing and refreshing molecule facts
 * (safe to run repeatedly). Needs the owner connection: reference data is read-only to
 * clinics.
 */
export async function seedSampleMedicines(db: Db): Promise<number> {
  const ids = new Map<string, string>();
  for (const [name, drugClass, f] of MOLECULES) {
    const facts = {
      drugClass,
      pregnancy: f.pregnancy ?? null,
      pregnancyOverridable: f.pregnancyOverridable ?? false,
      lactation: f.lactation ?? null,
      weightBased: f.weightBased ?? false,
      childMinMgPerKgDay: f.child?.[0] ?? null,
      childMaxMgPerKgDay: f.child?.[1] ?? null,
      childDoseOverridable: f.childDoseOverridable ?? true,
      maxDailyMg: f.maxDailyMg ?? null,
      maxDoseOverridable: f.maxDoseOverridable ?? true,
      olderAdultCaution: f.olderAdultCaution ?? false,
      renalAdjustment: f.renalAdjustment ?? false,
      hepaticCaution: f.hepaticCaution ?? false,
      telemedicineList: f.telemedicineList ?? null,
    };
    const m = await db.drugMolecule.upsert({
      where: { name },
      create: { name, ...facts },
      update: facts,
    });
    ids.set(name, m.id);
  }
  const id = (name: string) => {
    const found = ids.get(name);
    if (!found) throw new Error(`Unknown sample molecule ${name}`);
    return found;
  };

  let added = 0;
  for (const [name, composition, form, ingredients, route] of MEDICINES) {
    let medicine = await db.medicine.findFirst({ where: { organisationId: null, name } });
    if (!medicine) {
      medicine = await db.medicine.create({
        data: {
          name,
          genericName: ingredients.map(([m]) => m).join(' + '),
          composition,
          form,
          defaultRoute: route ?? 'oral',
          source: 'reference',
        },
      });
      added += 1;
    }
    for (const [molecule, mg, per] of ingredients) {
      const strength = { strengthMg: mg ?? null, per: per ?? null };
      await db.medicineIngredient.upsert({
        where: { medicineId_moleculeId: { medicineId: medicine.id, moleculeId: id(molecule) } },
        create: { medicineId: medicine.id, moleculeId: id(molecule), ...strength },
        update: strength,
      });
    }
  }

  for (const [a, b, severity, note] of INTERACTIONS) {
    const [moleculeAId, moleculeBId] = [id(a), id(b)].sort();
    await db.drugInteraction.upsert({
      where: { moleculeAId_moleculeBId: { moleculeAId: moleculeAId!, moleculeBId: moleculeBId! } },
      create: { moleculeAId: moleculeAId!, moleculeBId: moleculeBId!, severity, note },
      update: { severity, note },
    });
  }
  for (const [allergyClass, drugClass, note] of CROSS_SENSITIVITIES) {
    await db.drugCrossSensitivity.upsert({
      where: { allergyClass_drugClass: { allergyClass, drugClass } },
      create: { allergyClass, drugClass, note },
      update: { note },
    });
  }
  for (const [target, conditionCodes, conditionTerms, note] of CONDITION_RULES) {
    const where =
      'molecule' in target
        ? { moleculeId: id(target.molecule), drugClass: null }
        : { moleculeId: null, drugClass: target.drugClass };
    const exists = await db.drugConditionRule.findFirst({ where: { ...where, note } });
    if (exists) {
      await db.drugConditionRule.update({
        where: { id: exists.id },
        data: { conditionCodes, conditionTerms },
      });
    } else {
      await db.drugConditionRule.create({
        data: { ...where, conditionCodes, conditionTerms, note },
      });
    }
  }
  await db.drugDatabase.upsert({
    where: { id: 1 },
    create: { id: 1, version: SAMPLE_DRUG_DATA_VERSION },
    update: { version: SAMPLE_DRUG_DATA_VERSION, loadedAt: new Date() },
  });
  return added;
}
