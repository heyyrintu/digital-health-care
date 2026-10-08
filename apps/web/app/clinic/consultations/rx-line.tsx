'use client';

import type {
  DoseStep,
  DoseTiming,
  DurationUnit,
  Language,
  MedicineRoute,
  PrescriptionItem,
} from '@dhc/contracts';
import { dosageRemarks } from '@dhc/domain';
import { Button, Chip, cn, Input, Label, NativeSelect, Textarea } from '@dhc/ui-web';
import { Plus } from 'lucide-react';
import { useSession } from '../session-provider';

const TIMINGS: DoseTiming[] = [
  'after_food',
  'before_food',
  'with_food',
  'empty_stomach',
  'bedtime',
];
const ROUTES: MedicineRoute[] = [
  'oral',
  'topical',
  'inhaled',
  'eye',
  'ear',
  'nasal',
  'injection',
  'other',
];
const UNITS: DurationUnit[] = ['days', 'weeks', 'months'];

/** The remark the server will print for a line, previewed as the doctor types. */
export const remarksOf = (item: PrescriptionItem, language: Language) =>
  item.remarksEdited
    ? item.remarks
    : dosageRemarks({ steps: item.steps, timing: item.timing, route: item.route }, language);

/** One medicine line (PRD §6.4): dose, frequency, duration per step, timing, route and remarks. */
export function RxLine({
  item,
  index,
  language,
  editable,
  onChange,
  onRemove,
}: {
  item: PrescriptionItem;
  index: number;
  language: Language;
  editable: boolean;
  onChange(item: PrescriptionItem): void;
  onRemove(): void;
}) {
  const { t } = useSession();
  const set = (patch: Partial<PrescriptionItem>) => onChange({ ...item, ...patch });
  const setStep = (i: number, patch: Partial<DoseStep>) =>
    set({ steps: item.steps.map((s, j) => (i === j ? { ...s, ...patch } : s)) });
  const id = (field: string) => `rx-${index}-${field}`;
  const remarks = remarksOf(item, language);

  return (
    <li className="space-y-3 rounded-xl border border-border p-4" data-testid={`rx-line-${index}`}>
      <div className="flex items-start justify-between gap-3">
        <p className="m-0 min-w-0 [overflow-wrap:anywhere]">
          <span className="font-bold tabular">{index + 1}. </span>
          <strong>{item.name}</strong>
          {item.composition && (
            <span className="text-sm text-muted-foreground"> · {item.composition}</span>
          )}
          {!item.medicineId && (
            <Chip className="ml-2 bg-warning-soft text-warning-foreground">
              {t('rx.notInMaster')}
            </Chip>
          )}
        </p>
        {editable && (
          <Button
            type="button"
            variant="link"
            className="h-auto shrink-0 px-0 py-1 text-destructive"
            aria-label={t('rx.removeLine', { name: item.name })}
            onClick={onRemove}
          >
            {t('consult.remove')}
          </Button>
        )}
      </div>

      {item.steps.map((step, i) => (
        <div className={stepGrid} key={i}>
          {item.steps.length > 1 && (
            <p className={cn(groupHeading, 'col-span-full')}>{t('rx.step', { n: i + 1 })}</p>
          )}
          <div className={cell}>
            <Label htmlFor={id(`dose-${i}`)} className={fieldLabel}>
              {t('rx.dose')}
            </Label>
            <Input
              id={id(`dose-${i}`)}
              value={step.dose}
              maxLength={60}
              onChange={(e) => setStep(i, { dose: e.target.value })}
            />
          </div>
          <div className={cell}>
            <Label htmlFor={id(`frequency-${i}`)} className={fieldLabel}>
              {t('rx.frequency')}
            </Label>
            <Input
              id={id(`frequency-${i}`)}
              value={step.frequency}
              placeholder={t('rx.frequencyHint')}
              maxLength={60}
              onChange={(e) => setStep(i, { frequency: e.target.value })}
            />
          </div>
          <div className={cell}>
            <Label htmlFor={id(`duration-${i}`)} className={fieldLabel}>
              {t('rx.duration')}
            </Label>
            <Input
              id={id(`duration-${i}`)}
              type="number"
              min={1}
              max={365}
              step={1}
              className="tabular"
              value={step.durationValue ?? ''}
              onChange={(e) => {
                // Keep the last valid number while the box holds a fraction or is out of range.
                if (e.target.value && !e.target.validity.valid) return;
                setStep(i, {
                  durationValue: e.target.value ? Number(e.target.value) : null,
                  durationUnit: step.durationUnit ?? 'days',
                });
              }}
            />
          </div>
          <div className={cell}>
            <Label htmlFor={id(`unit-${i}`)} className={fieldLabel}>
              {t('rx.unit')}
            </Label>
            <NativeSelect
              id={id(`unit-${i}`)}
              value={step.durationUnit ?? 'days'}
              onChange={(e) => setStep(i, { durationUnit: e.target.value as DurationUnit })}
            >
              {UNITS.map((u) => (
                <option key={u} value={u}>
                  {t(`rx.unit.${u}`)}
                </option>
              ))}
            </NativeSelect>
          </div>
          {i > 0 && (
            <Button
              type="button"
              variant="link"
              className="col-span-full justify-self-start px-0 text-destructive"
              onClick={() => set({ steps: item.steps.filter((_, j) => j !== i) })}
            >
              {t('rx.removeStep')}
            </Button>
          )}
        </div>
      ))}
      {editable && item.steps.length < 6 && (
        <Button
          type="button"
          variant="link"
          className="px-0"
          onClick={() =>
            set({
              steps: [...item.steps, { ...item.steps[item.steps.length - 1]!, frequency: '' }],
            })
          }
        >
          <Plus aria-hidden />
          {t('rx.addStep')}
        </Button>
      )}

      <div className={stepGrid}>
        <div className={cell}>
          <Label htmlFor={id('timing')} className={fieldLabel}>
            {t('rx.timing')}
          </Label>
          <NativeSelect
            id={id('timing')}
            value={item.timing ?? ''}
            onChange={(e) => set({ timing: (e.target.value || null) as DoseTiming | null })}
          >
            <option value="">{t('rx.timing.none')}</option>
            {TIMINGS.map((x) => (
              <option key={x} value={x}>
                {t(`rx.timing.${x}`)}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className={cell}>
          <Label htmlFor={id('route')} className={fieldLabel}>
            {t('rx.route')}
          </Label>
          <NativeSelect
            id={id('route')}
            value={item.route ?? ''}
            onChange={(e) => set({ route: (e.target.value || null) as MedicineRoute | null })}
          >
            <option value="">{t('rx.timing.none')}</option>
            {ROUTES.map((r) => (
              <option key={r} value={r}>
                {t(`rx.route.${r}`)}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className={cell}>
          <Label htmlFor={id('quantity')} className={fieldLabel}>
            {t('rx.quantity')}
          </Label>
          <Input
            id={id('quantity')}
            value={item.quantity ?? ''}
            maxLength={60}
            onChange={(e) => set({ quantity: e.target.value || null })}
          />
        </div>
        <div className={cell}>
          <Label htmlFor={id('instructions')} className={fieldLabel}>
            {t('rx.instructions')}
          </Label>
          <Input
            id={id('instructions')}
            value={item.instructions ?? ''}
            maxLength={300}
            onChange={(e) => set({ instructions: e.target.value || null })}
          />
        </div>
      </div>

      <div className="space-y-1.5 border-t border-border pt-3">
        <Label htmlFor={id('remarks')} className={fieldLabel}>
          {t('rx.remarks')}
        </Label>
        {item.remarksEdited ? (
          <Textarea
            id={id('remarks')}
            rows={2}
            maxLength={1200}
            value={item.remarks}
            onChange={(e) => set({ remarks: e.target.value })}
          />
        ) : (
          <p
            id={id('remarks')}
            className="m-0 rounded-xl bg-muted px-3.5 py-2.5 text-sm"
            data-testid="rx-remarks"
          >
            {remarks || '—'}
          </p>
        )}
        {editable && (
          <Button
            type="button"
            variant="link"
            className="px-0"
            onClick={() =>
              item.remarksEdited
                ? set({ remarksEdited: false, remarks: '' })
                : set({ remarksEdited: true, remarks })
            }
          >
            {item.remarksEdited ? t('rx.autoRemarks') : t('rx.editRemarks')}
          </Button>
        )}
      </div>
    </li>
  );
}

const fieldLabel = 'block text-sm font-semibold';
const groupHeading = 'text-[11px] font-bold uppercase tracking-wide text-muted-foreground';
const stepGrid =
  'grid grid-cols-2 items-end gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,2fr)_minmax(0,1fr)_minmax(0,1.2fr)]';
const cell = 'min-w-0 space-y-1.5';
