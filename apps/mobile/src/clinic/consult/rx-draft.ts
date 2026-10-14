import type {
  DurationUnit,
  Language,
  Medicine,
  PrescriptionItem,
  SavePrescriptionBody,
} from '@dhc/contracts';
import { dosageRemarks } from '@dhc/domain';

/**
 * The prescription as the doctor edits it on the device: plain lines, saved to the server
 * on demand (`PUT /appointments/{id}/prescription`), which checks safety on every save.
 * Remarks are worked out on the device for the preview; the server writes the final ones.
 */
export interface DraftLine {
  id: string;
  medicineId: string | null;
  name: string;
  composition: string | null;
  form: string | null;
  route: PrescriptionItem['route'];
  timing: PrescriptionItem['timing'];
  dose: string;
  frequency: string;
  durationValue: number | null;
  durationUnit: DurationUnit | null;
  instructions: string;
  /** Kept from the server for lines this screen does not edit in full (tapering steps). */
  extraSteps: PrescriptionItem['steps'];
  quantity: string | null;
  remarks: string;
  remarksEdited: boolean;
}

export function lineFromMedicine(id: string, m: Medicine): DraftLine {
  return {
    id,
    medicineId: m.id,
    name: m.name,
    composition: m.composition,
    form: m.form,
    route: m.defaultRoute,
    timing: 'after_food',
    dose: '1',
    frequency: '',
    durationValue: null,
    durationUnit: 'days',
    instructions: '',
    extraSteps: [],
    quantity: null,
    remarks: '',
    remarksEdited: false,
  };
}

/** A medicine not in the list: flagged on the prescription and sent to the approval queue. */
export function freeTextLine(id: string, name: string): DraftLine {
  return {
    ...lineFromMedicine(id, {
      id: '',
      name: name.trim(),
      genericName: '',
      composition: '',
      form: '',
      defaultRoute: 'oral',
      source: 'clinic',
    }),
    medicineId: null,
    composition: null,
    form: null,
    route: null,
  };
}

export function lineFromItem(item: PrescriptionItem): DraftLine {
  const [first, ...rest] = item.steps;
  return {
    id: item.id,
    medicineId: item.medicineId,
    name: item.name,
    composition: item.composition,
    form: item.form,
    route: item.route,
    timing: item.timing,
    dose: first?.dose ?? '',
    frequency: first?.frequency ?? '',
    durationValue: first?.durationValue ?? null,
    durationUnit: first?.durationUnit ?? null,
    instructions: item.instructions ?? '',
    extraSteps: rest,
    quantity: item.quantity,
    remarks: item.remarks,
    remarksEdited: item.remarksEdited,
  };
}

const firstStep = (l: DraftLine) => ({
  dose: l.dose.trim(),
  frequency: l.frequency.trim(),
  durationValue: l.durationValue,
  durationUnit: l.durationValue === null ? l.durationUnit : (l.durationUnit ?? 'days'),
});

/** The remark the server will print, for the preview while editing. */
export function previewRemarks(line: DraftLine, language: Language): string {
  if (line.remarksEdited) return line.remarks;
  return dosageRemarks(
    { steps: [firstStep(line), ...line.extraSteps], route: line.route, timing: line.timing },
    language,
  );
}

export function toSaveBody(
  lines: DraftLine[],
  language: Language,
  revision: number,
): SavePrescriptionBody {
  return {
    language,
    revision,
    items: lines.map((l) => ({
      id: l.id,
      medicineId: l.medicineId,
      name: l.name.trim(),
      composition: l.composition,
      form: l.form,
      route: l.route,
      timing: l.timing,
      steps: [firstStep(l), ...l.extraSteps],
      quantity: l.quantity,
      instructions: l.instructions.trim() || null,
      remarks: l.remarksEdited ? l.remarks : previewRemarks(l, language),
      remarksEdited: l.remarksEdited,
    })),
  };
}

/** Whether signing can go ahead, and if not, why (for the button's explanation). */
export function signBlocker(input: {
  dirty: boolean;
  lines: number;
  openBlocks: number;
  openWarnings: number;
  missing: string[];
}): 'unsaved' | 'empty' | 'blocks' | 'warnings' | 'setup' | null {
  if (input.dirty) return 'unsaved';
  if (input.lines === 0) return 'empty';
  if (input.openBlocks > 0) return 'blocks';
  if (input.openWarnings > 0) return 'warnings';
  if (input.missing.length > 0) return 'setup';
  return null;
}
