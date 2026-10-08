'use client';

import {
  DrugMoleculeList,
  MedicineRoute,
  type MasterMedicine,
  type SaveMedicineBody,
} from '@dhc/contracts';
import { Button, Field, Input, NativeSelect } from '@dhc/ui-web';
import { useEffect, useState, type FormEvent } from 'react';
import { useSession } from '../session-provider';

type Molecule = DrugMoleculeList['data'][number];

interface IngredientRow {
  moleculeId: string;
  moleculeName: string;
  strength: string;
  per: '' | 'unit' | 'ml';
}

const H3 = 'font-display text-base font-bold';

/**
 * Add or edit a clinic medicine: the details doctors see in search, plus the molecules the
 * safety checks need. Used from the list and when approving a typed name as a new medicine.
 */
export function MedicineForm({
  title,
  initial,
  submitLabel,
  busy,
  onSubmit,
  onCancel,
}: {
  title: string;
  initial?: Partial<MasterMedicine>;
  submitLabel: string;
  busy: boolean;
  onSubmit: (body: SaveMedicineBody) => void;
  onCancel: () => void;
}) {
  const { t } = useSession();
  const [ingredients, setIngredients] = useState<IngredientRow[]>(
    () =>
      initial?.ingredients?.map((i) => ({
        moleculeId: i.moleculeId,
        moleculeName: i.moleculeName,
        strength: i.strengthMg === null ? '' : String(i.strengthMg),
        per: i.per ?? '',
      })) ?? [],
  );

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const text = (key: string) => String(data.get(key) ?? '');
    onSubmit({
      name: text('name'),
      genericName: text('genericName'),
      composition: text('composition'),
      form: text('form'),
      defaultRoute: MedicineRoute.parse(text('defaultRoute')),
      ingredients: ingredients.map((i) => ({
        moleculeId: i.moleculeId,
        strengthMg: i.per === '' ? null : Number(i.strength),
        per: i.per === '' ? null : i.per,
      })),
    });
  }

  const change = (index: number, patch: Partial<IngredientRow>) =>
    setIngredients((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  return (
    <form
      aria-label={title}
      className="space-y-4 rounded-xl border border-border bg-card p-4"
      onSubmit={submit}
    >
      <h3 className={H3}>{title}</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('medicines.name')}>
          <Input name="name" required maxLength={120} defaultValue={initial?.name} />
        </Field>
        <Field label={t('medicines.genericName')}>
          <Input name="genericName" required maxLength={200} defaultValue={initial?.genericName} />
        </Field>
        <Field label={t('medicines.composition')} hint={t('medicines.compositionHint')}>
          <Input name="composition" required maxLength={300} defaultValue={initial?.composition} />
        </Field>
        <Field label={t('medicines.form')} hint={t('medicines.formHint')}>
          <Input name="form" required maxLength={40} defaultValue={initial?.form} />
        </Field>
        <Field label={t('medicines.route')}>
          <NativeSelect name="defaultRoute" defaultValue={initial?.defaultRoute ?? 'oral'}>
            {MedicineRoute.options.map((route) => (
              <option key={route} value={route}>
                {t(`rx.route.${route}`)}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>

      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold">{t('medicines.ingredients')}</legend>
        <p className="text-xs text-muted-foreground">{t('medicines.ingredientsHint')}</p>
        {ingredients.length > 0 && (
          <ul className="space-y-2">
            {ingredients.map((row, index) => (
              <li
                key={row.moleculeId}
                data-testid={`ingredient-${row.moleculeName}`}
                className="flex flex-wrap items-end gap-3 rounded-lg bg-muted/50 p-3"
              >
                <strong className="w-full text-sm sm:w-40">{row.moleculeName}</strong>
                <div className="w-full sm:w-52">
                  <Field label={t('medicines.per')}>
                    <NativeSelect
                      value={row.per}
                      onChange={(e) =>
                        change(index, {
                          per: e.target.value as IngredientRow['per'],
                          ...(e.target.value === '' ? { strength: '' } : {}),
                        })
                      }
                    >
                      <option value="">{t('medicines.perNone')}</option>
                      <option value="unit">{t('medicines.perUnit')}</option>
                      <option value="ml">{t('medicines.perMl')}</option>
                    </NativeSelect>
                  </Field>
                </div>
                <div className="w-full sm:w-32">
                  <Field label={t('medicines.strength')}>
                    <Input
                      type="number"
                      min={0.001}
                      max={1_000_000}
                      step="any"
                      required={row.per !== ''}
                      disabled={row.per === ''}
                      value={row.strength}
                      onChange={(e) => change(index, { strength: e.target.value })}
                    />
                  </Field>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setIngredients((rows) => rows.filter((_, i) => i !== index))}
                >
                  {t('medicines.removeMolecule', { name: row.moleculeName })}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {ingredients.length < 10 && (
          <MoleculeSearch
            exclude={ingredients.map((i) => i.moleculeId)}
            onPick={(m) =>
              setIngredients((rows) => [
                ...rows,
                { moleculeId: m.id, moleculeName: m.name, strength: '', per: '' },
              ])
            }
          />
        )}
      </fieldset>

      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy}>
          {submitLabel}
        </Button>
        <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}

/** Search the reference molecules; picking one adds it as an ingredient. */
function MoleculeSearch({
  exclude,
  onPick,
}: {
  exclude: string[];
  onPick: (molecule: Molecule) => void;
}) {
  const { api, t } = useSession();
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<Molecule[] | null>(null);
  const q = query.trim();

  useEffect(() => {
    if (q.length < 2) return void setMatches(null);
    let current = true;
    const timer = setTimeout(() => {
      api
        .request('GET', '/drug-molecules', { schema: DrugMoleculeList, query: { q } })
        .then((list) => current && setMatches(list.data))
        .catch(() => current && setMatches([]));
    }, 250);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [api, q]);

  const shown = matches?.filter((m) => !exclude.includes(m.id));
  return (
    <div className="space-y-2">
      <div className="sm:w-72">
        <Field label={t('medicines.findMolecule')} hint={t('medicines.findMoleculeHint')}>
          <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} />
        </Field>
      </div>
      {shown && (
        <ul className="flex flex-wrap gap-2" aria-live="polite">
          {shown.length === 0 && (
            <li className="text-sm text-muted-foreground">{t('medicines.noMolecules')}</li>
          )}
          {shown.map((m) => (
            <li key={m.id}>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  onPick(m);
                  setQuery('');
                }}
              >
                {t('medicines.addMolecule', { name: m.name })}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
