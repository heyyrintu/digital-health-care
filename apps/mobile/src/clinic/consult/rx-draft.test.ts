import type { Medicine, PrescriptionItem } from '@dhc/contracts';
import { describe, expect, it } from 'vitest';
import {
  freeTextLine,
  lineFromItem,
  lineFromMedicine,
  previewRemarks,
  signBlocker,
  toSaveBody,
} from './rx-draft';

const paracetamol: Medicine = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Paracetamol 650',
  genericName: 'PARACETAMOL',
  composition: 'Paracetamol 650 mg',
  form: 'tablet',
  defaultRoute: 'oral',
  source: 'reference',
};

describe('prescription draft', () => {
  it('turns a picked medicine into a line the server accepts, with the remark preview', () => {
    const line = {
      ...lineFromMedicine('22222222-2222-4222-8222-222222222222', paracetamol),
      frequency: '1-0-1',
      durationValue: 5,
    };
    expect(previewRemarks(line, 'en')).toMatch(/5 days/);
    const body = toSaveBody([line], 'en', 3);
    expect(body).toMatchObject({
      language: 'en',
      revision: 3,
      items: [
        {
          medicineId: paracetamol.id,
          name: 'Paracetamol 650',
          route: 'oral',
          timing: 'after_food',
          steps: [{ dose: '1', frequency: '1-0-1', durationValue: 5, durationUnit: 'days' }],
          instructions: null,
          remarksEdited: false,
        },
      ],
    });
    expect(body.items[0]!.remarks).toBe(previewRemarks(line, 'en'));
    expect(previewRemarks(line, 'hi')).not.toBe(previewRemarks(line, 'en'));
  });

  it('keeps free-text medicines unlinked and tapering steps it does not edit', () => {
    expect(
      toSaveBody([freeTextLine('33333333-3333-4333-8333-333333333333', ' Zerodol SP ')], 'en', 0)
        .items[0],
    ).toMatchObject({
      medicineId: null,
      name: 'Zerodol SP',
      route: null,
    });
    const tapering: PrescriptionItem = {
      id: '44444444-4444-4444-8444-444444444444',
      medicineId: null,
      name: 'Prednisolone',
      composition: null,
      form: null,
      route: 'oral',
      timing: null,
      steps: [
        { dose: '20 mg', frequency: 'OD', durationValue: 5, durationUnit: 'days' },
        { dose: '10 mg', frequency: 'OD', durationValue: 5, durationUnit: 'days' },
      ],
      quantity: null,
      instructions: null,
      remarks: 'Doctor’s own words',
      remarksEdited: true,
    };
    const round = toSaveBody([lineFromItem(tapering)], 'en', 1).items[0]!;
    expect(round.steps).toEqual(tapering.steps);
    expect(round.remarks).toBe('Doctor’s own words');
  });

  it('explains what stops signing, in order', () => {
    const base = { dirty: false, lines: 2, openBlocks: 0, openWarnings: 0, missing: [] };
    expect(signBlocker(base)).toBeNull();
    expect(signBlocker({ ...base, dirty: true, openBlocks: 1 })).toBe('unsaved');
    expect(signBlocker({ ...base, lines: 0 })).toBe('empty');
    expect(signBlocker({ ...base, openBlocks: 1, openWarnings: 2 })).toBe('blocks');
    expect(signBlocker({ ...base, openWarnings: 2 })).toBe('warnings');
    expect(signBlocker({ ...base, missing: ['pin'] })).toBe('setup');
  });
});
