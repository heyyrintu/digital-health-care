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
    <li className="rx-line" data-testid={`rx-line-${index}`}>
      <div className="card-header">
        <p className="rx-name">
          <strong>{item.name}</strong>
          {item.composition && <span className="hint"> · {item.composition}</span>}
          {!item.medicineId && <span className="pill">{t('rx.notInMaster')}</span>}
        </p>
        {editable && (
          <button
            type="button"
            className="link-button"
            aria-label={t('rx.removeLine', { name: item.name })}
            onClick={onRemove}
          >
            {t('consult.remove')}
          </button>
        )}
      </div>

      {item.steps.map((step, i) => (
        <div className="rx-step" key={i}>
          {item.steps.length > 1 && <p className="hint">{t('rx.step', { n: i + 1 })}</p>}
          <div>
            <label htmlFor={id(`dose-${i}`)}>{t('rx.dose')}</label>
            <input
              id={id(`dose-${i}`)}
              value={step.dose}
              maxLength={60}
              onChange={(e) => setStep(i, { dose: e.target.value })}
            />
          </div>
          <div>
            <label htmlFor={id(`frequency-${i}`)}>{t('rx.frequency')}</label>
            <input
              id={id(`frequency-${i}`)}
              value={step.frequency}
              placeholder={t('rx.frequencyHint')}
              maxLength={60}
              onChange={(e) => setStep(i, { frequency: e.target.value })}
            />
          </div>
          <div>
            <label htmlFor={id(`duration-${i}`)}>{t('rx.duration')}</label>
            <input
              id={id(`duration-${i}`)}
              type="number"
              min={1}
              max={365}
              value={step.durationValue ?? ''}
              onChange={(e) =>
                setStep(i, {
                  durationValue: e.target.value ? Number(e.target.value) : null,
                  durationUnit: step.durationUnit ?? 'days',
                })
              }
            />
          </div>
          <div>
            <label htmlFor={id(`unit-${i}`)}>{t('rx.unit')}</label>
            <select
              id={id(`unit-${i}`)}
              value={step.durationUnit ?? 'days'}
              onChange={(e) => setStep(i, { durationUnit: e.target.value as DurationUnit })}
            >
              {UNITS.map((u) => (
                <option key={u} value={u}>
                  {t(`rx.unit.${u}`)}
                </option>
              ))}
            </select>
          </div>
          {i > 0 && (
            <button
              type="button"
              className="link-button"
              onClick={() => set({ steps: item.steps.filter((_, j) => j !== i) })}
            >
              {t('rx.removeStep')}
            </button>
          )}
        </div>
      ))}
      {editable && item.steps.length < 6 && (
        <button
          type="button"
          className="link-button"
          onClick={() =>
            set({
              steps: [...item.steps, { ...item.steps[item.steps.length - 1]!, frequency: '' }],
            })
          }
        >
          {t('rx.addStep')}
        </button>
      )}

      <div className="rx-step">
        <div>
          <label htmlFor={id('timing')}>{t('rx.timing')}</label>
          <select
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
          </select>
        </div>
        <div>
          <label htmlFor={id('route')}>{t('rx.route')}</label>
          <select
            id={id('route')}
            value={item.route ?? 'oral'}
            onChange={(e) => set({ route: e.target.value as MedicineRoute })}
          >
            {ROUTES.map((r) => (
              <option key={r} value={r}>
                {t(`rx.route.${r}`)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={id('quantity')}>{t('rx.quantity')}</label>
          <input
            id={id('quantity')}
            value={item.quantity ?? ''}
            maxLength={60}
            onChange={(e) => set({ quantity: e.target.value || null })}
          />
        </div>
        <div>
          <label htmlFor={id('instructions')}>{t('rx.instructions')}</label>
          <input
            id={id('instructions')}
            value={item.instructions ?? ''}
            maxLength={300}
            onChange={(e) => set({ instructions: e.target.value || null })}
          />
        </div>
      </div>

      <div className="rx-remarks">
        <label htmlFor={id('remarks')}>{t('rx.remarks')}</label>
        {item.remarksEdited ? (
          <textarea
            id={id('remarks')}
            rows={2}
            maxLength={600}
            value={item.remarks}
            onChange={(e) => set({ remarks: e.target.value })}
          />
        ) : (
          <p id={id('remarks')} className="summary" data-testid="rx-remarks">
            {remarks || '—'}
          </p>
        )}
        {editable && (
          <button
            type="button"
            className="link-button"
            onClick={() =>
              item.remarksEdited
                ? set({ remarksEdited: false, remarks: '' })
                : set({ remarksEdited: true, remarks })
            }
          >
            {item.remarksEdited ? t('rx.autoRemarks') : t('rx.editRemarks')}
          </button>
        )}
      </div>
    </li>
  );
}
