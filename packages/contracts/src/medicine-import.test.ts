import { expect, it } from 'vitest';
import { ClinicalIngredientMapping, ClinicalMapping } from './medicine-import';

const ingredient = () => ({
  sourceId: '990000000000000101',
  canonicalName: 'Synthetic substance',
  strengthStatus: 'unmapped',
  value: null,
  unit: null,
  per: null,
  reason: null,
});
it('never treats a partial or absent strength as a known numeric strength', () => {
  expect(ClinicalIngredientMapping.safeParse(ingredient()).success).toBe(true);
  for (const patch of [
    { value: 5 },
    { strengthStatus: 'mapped', value: 5, unit: 'mg' },
    { strengthStatus: 'mapped', value: 0, unit: 'mg', per: 'unit' },
    { strengthStatus: 'mapped', value: Infinity, unit: 'mg', per: 'unit' },
    { strengthStatus: 'not_applicable' },
  ])
    expect(ClinicalIngredientMapping.safeParse({ ...ingredient(), ...patch }).success).toBe(false);
  expect(
    ClinicalIngredientMapping.safeParse({
      ...ingredient(),
      strengthStatus: 'not_applicable',
      reason: 'Synthetic fixture explanation only.',
    }).success,
  ).toBe(true);
});
it('preserves explicit non-mass strengths without inventing mg conversions', () => {
  expect(
    ClinicalIngredientMapping.parse({
      ...ingredient(),
      strengthStatus: 'mapped',
      value: 100,
      unit: 'IU',
      per: 'ml',
    }),
  ).toMatchObject({ value: 100, unit: 'IU', per: 'ml' });
  const percentage = {
    ...ingredient(),
    strengthStatus: 'mapped',
    value: 1,
    unit: 'percent',
    per: null,
    reason: 'Synthetic fixture concentration basis evidence.',
  };
  expect(ClinicalIngredientMapping.parse(percentage).value).toBe(1);
  expect(ClinicalIngredientMapping.safeParse({ ...percentage, per: 'ml' }).success).toBe(false);
  expect(ClinicalIngredientMapping.safeParse({ ...percentage, value: 101 }).success).toBe(false);
});
it('requires complete clinician review and a unique source ingredient set', () => {
  const value = {
    form: null,
    route: null,
    ingredients: [ingredient()],
    regulatoryEvidence: null,
    notes: '',
    decision: 'draft',
    reviewerName: null,
    reviewerRegistration: null,
    reviewAttested: false,
  };
  expect(ClinicalMapping.safeParse(value).success).toBe(true);
  expect(ClinicalMapping.safeParse({ ...value, decision: 'review_recorded' }).success).toBe(false);
  expect(
    ClinicalMapping.safeParse({ ...value, ingredients: [ingredient(), ingredient()] }).success,
  ).toBe(false);
});
