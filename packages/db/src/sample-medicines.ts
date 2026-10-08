import type { Db } from './client.ts';

/**
 * A synthetic sample of the reference medicine master for development and tests: generic
 * products with common Indian strengths, no brand names. Production loads the licensed
 * drug database instead (with Indian brand mapping); nothing here is clinical advice.
 */
const MOLECULES: [name: string, drugClass: string][] = [
  ['Paracetamol', 'Analgesic and antipyretic'],
  ['Ibuprofen', 'NSAID'],
  ['Diclofenac', 'NSAID'],
  ['Aceclofenac', 'NSAID'],
  ['Etoricoxib', 'NSAID'],
  ['Naproxen', 'NSAID'],
  ['Tramadol', 'Opioid analgesic'],
  ['Pantoprazole', 'Proton pump inhibitor'],
  ['Rabeprazole', 'Proton pump inhibitor'],
  ['Amoxicillin', 'Penicillin'],
  ['Clavulanic acid', 'Beta-lactamase inhibitor'],
  ['Cefixime', 'Cephalosporin'],
  ['Azithromycin', 'Macrolide'],
  ['Cetirizine', 'Antihistamine'],
  ['Thiocolchicoside', 'Muscle relaxant'],
  ['Calcium carbonate', 'Calcium supplement'],
  ['Cholecalciferol', 'Vitamin D'],
  ['Pregabalin', 'Gabapentinoid'],
  ['Methylcobalamin', 'Vitamin B12'],
  ['Prednisolone', 'Corticosteroid'],
  ['Warfarin', 'Anticoagulant'],
  ['Metformin', 'Biguanide'],
  ['Amlodipine', 'Calcium channel blocker'],
  ['Ondansetron', 'Antiemetic'],
  ['Propranolol', 'Non-selective beta-blocker'],
  ['Glucosamine', 'Supplement'],
];

type Route = 'oral' | 'topical';
const MEDICINES: [
  name: string,
  composition: string,
  form: string,
  molecules: string[],
  route?: Route,
][] = [
  ['Paracetamol 500', 'Paracetamol 500 mg', 'tablet', ['Paracetamol']],
  ['Paracetamol 650', 'Paracetamol 650 mg', 'tablet', ['Paracetamol']],
  ['Paracetamol syrup', 'Paracetamol 250 mg/5 ml', 'syrup', ['Paracetamol']],
  ['Ibuprofen 400', 'Ibuprofen 400 mg', 'tablet', ['Ibuprofen']],
  ['Diclofenac 50', 'Diclofenac sodium 50 mg', 'tablet', ['Diclofenac']],
  ['Diclofenac gel', 'Diclofenac diethylamine 1.16% w/w', 'gel', ['Diclofenac'], 'topical'],
  [
    'Aceclofenac + Paracetamol',
    'Aceclofenac 100 mg + Paracetamol 325 mg',
    'tablet',
    ['Aceclofenac', 'Paracetamol'],
  ],
  ['Etoricoxib 90', 'Etoricoxib 90 mg', 'tablet', ['Etoricoxib']],
  ['Naproxen 500', 'Naproxen 500 mg', 'tablet', ['Naproxen']],
  [
    'Tramadol + Paracetamol',
    'Tramadol 37.5 mg + Paracetamol 325 mg',
    'tablet',
    ['Tramadol', 'Paracetamol'],
  ],
  ['Pantoprazole 40', 'Pantoprazole 40 mg', 'tablet', ['Pantoprazole']],
  ['Rabeprazole 20', 'Rabeprazole 20 mg', 'tablet', ['Rabeprazole']],
  ['Amoxicillin 500', 'Amoxicillin 500 mg', 'capsule', ['Amoxicillin']],
  [
    'Amoxicillin + Clavulanic acid 625',
    'Amoxicillin 500 mg + Clavulanic acid 125 mg',
    'tablet',
    ['Amoxicillin', 'Clavulanic acid'],
  ],
  ['Cefixime 200', 'Cefixime 200 mg', 'tablet', ['Cefixime']],
  ['Azithromycin 500', 'Azithromycin 500 mg', 'tablet', ['Azithromycin']],
  ['Cetirizine 10', 'Cetirizine 10 mg', 'tablet', ['Cetirizine']],
  ['Thiocolchicoside 4', 'Thiocolchicoside 4 mg', 'capsule', ['Thiocolchicoside']],
  [
    'Calcium + Vitamin D3',
    'Calcium carbonate 1250 mg + Cholecalciferol 250 IU',
    'tablet',
    ['Calcium carbonate', 'Cholecalciferol'],
  ],
  ['Cholecalciferol 60000 IU', 'Cholecalciferol 60000 IU', 'sachet', ['Cholecalciferol']],
  ['Pregabalin 75', 'Pregabalin 75 mg', 'capsule', ['Pregabalin']],
  ['Methylcobalamin 1500', 'Methylcobalamin 1500 mcg', 'tablet', ['Methylcobalamin']],
  ['Prednisolone 10', 'Prednisolone 10 mg', 'tablet', ['Prednisolone']],
  ['Warfarin 5', 'Warfarin 5 mg', 'tablet', ['Warfarin']],
  ['Metformin 500', 'Metformin 500 mg', 'tablet', ['Metformin']],
  ['Amlodipine 5', 'Amlodipine 5 mg', 'tablet', ['Amlodipine']],
  ['Ondansetron 4', 'Ondansetron 4 mg', 'tablet', ['Ondansetron']],
  ['Propranolol 40', 'Propranolol 40 mg', 'tablet', ['Propranolol']],
  ['Glucosamine 500', 'Glucosamine sulphate 500 mg', 'tablet', ['Glucosamine']],
];

/**
 * Loads the sample master if it is not there yet (safe to run repeatedly). Needs the
 * owner connection: reference data is read-only to clinics.
 */
export async function seedSampleMedicines(db: Db): Promise<number> {
  const ids = new Map<string, string>();
  for (const [name, drugClass] of MOLECULES) {
    const m = await db.drugMolecule.upsert({
      where: { name },
      create: { name, drugClass },
      update: {},
    });
    ids.set(name, m.id);
  }
  let added = 0;
  for (const [name, composition, form, molecules, route] of MEDICINES) {
    const exists = await db.medicine.findFirst({ where: { organisationId: null, name } });
    if (exists) continue;
    await db.medicine.create({
      data: {
        name,
        genericName: molecules.join(' + '),
        composition,
        form,
        moleculeIds: molecules.map((m) => ids.get(m)!),
        defaultRoute: route ?? 'oral',
        source: 'reference',
      },
    });
    added += 1;
  }
  return added;
}
