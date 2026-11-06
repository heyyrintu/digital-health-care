'use client';
import {
  AssessmentForms,
  AssessmentForm,
  CreateAssessmentForm,
  type AssessmentDefinition,
} from '@dhc/contracts';
import { Button, Field, Input, Surface, Textarea } from '@dhc/ui-web';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ClinicShell, NotAllowed } from '../shell';
import { useSession } from '../session-provider';
const blank = (): AssessmentDefinition => ({
  title: '',
  titleHi: '',
  instructions: '',
  instructionsHi: '',
  questions: [{ id: 'q1', label: '', labelHi: '', min: 0, max: 10 }],
});
export default function Page() {
  return (
    <ClinicShell>
      {(me) => (['doctor', 'clinic_admin'].includes(me.role) ? <Forms /> : <NotAllowed />)}
    </ClinicShell>
  );
}
function Forms() {
  const { api, t } = useSession();
  const [rows, setRows] = useState<AssessmentForm[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [draft, setDraft] = useState(blank),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const pending = useRef<{ id: string; definition: AssessmentDefinition } | null>(null);
  const [recovering, setRecovering] = useState(false);
  const load = useCallback(
    async (next?: string) => {
      try {
        const r = await api.request('GET', '/assessment-forms' + (next ? '?cursor=' + next : ''), {
          schema: AssessmentForms,
        });
        setRows((old) => (next ? [...old, ...r.data] : r.data));
        setCursor(r.nextCursor);
      } catch {
        setError(t('assess.error'));
      }
    },
    [api, t],
  );
  useEffect(() => {
    void load();
  }, [load]);
  async function publish() {
    setError('');
    setNotice('');
    const parsed = CreateAssessmentForm.safeParse(
      pending.current ?? { id: crypto.randomUUID(), definition: draft },
    );
    if (!parsed.success) {
      setError(t('assess.invalid'));
      return;
    }
    pending.current = parsed.data;
    setRecovering(true);
    setBusy(true);
    try {
      await api.request('POST', '/assessment-forms', { schema: AssessmentForm, body: parsed.data });
      pending.current = null;
      setRecovering(false);
      setDraft(blank());
      setNotice(t('assess.published'));
      await load();
    } catch {
      setError(t('assess.retrySame'));
    } finally {
      setBusy(false);
    }
  }
  const patch = (i: number, key: 'label' | 'labelHi' | 'min' | 'max', value: string | number) =>
    setDraft((d) => ({
      ...d,
      questions: d.questions.map((q, n) => (n === i ? { ...q, [key]: value } : q)),
    }));
  return (
    <section className="space-y-6">
      <h1 className="font-display text-2xl font-bold">{t('assess.forms')}</h1>
      <p>{t('assess.scope')}</p>
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <Surface className="space-y-4 p-5">
        <h2 className="text-xl font-bold">{t('assess.new')}</h2>
        <p>{t('assess.immutable')}</p>
        <fieldset disabled={busy || recovering} className="space-y-4">
          <Field label={t('assess.titleEn')}>
            <Input
              value={draft.title}
              maxLength={120}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          </Field>
          <Field label={t('assess.titleHi')}>
            <Input
              value={draft.titleHi}
              maxLength={120}
              onChange={(e) => setDraft({ ...draft, titleHi: e.target.value })}
            />
          </Field>
          <Field label={t('assess.instructionsEn')}>
            <Textarea
              value={draft.instructions}
              maxLength={1200}
              onChange={(e) => setDraft({ ...draft, instructions: e.target.value })}
            />
          </Field>
          <Field label={t('assess.instructionsHi')}>
            <Textarea
              value={draft.instructionsHi}
              maxLength={1200}
              onChange={(e) => setDraft({ ...draft, instructionsHi: e.target.value })}
            />
          </Field>
          {draft.questions.map((q, i) => (
            <fieldset key={q.id} className="space-y-3 rounded-xl border border-border p-4">
              <legend>
                {t('assess.question')} {i + 1}
              </legend>
              <Field label={t('assess.questionEn')}>
                <Input
                  value={q.label}
                  maxLength={240}
                  onChange={(e) => patch(i, 'label', e.target.value)}
                />
              </Field>
              <Field label={t('assess.questionHi')}>
                <Input
                  value={q.labelHi}
                  maxLength={240}
                  onChange={(e) => patch(i, 'labelHi', e.target.value)}
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label={t('assess.minimum')}>
                  <Input
                    type="number"
                    min={0}
                    max={9}
                    value={q.min}
                    onChange={(e) => patch(i, 'min', Number(e.target.value))}
                  />
                </Field>
                <Field label={t('assess.maximum')}>
                  <Input
                    type="number"
                    min={1}
                    max={10}
                    value={q.max}
                    onChange={(e) => patch(i, 'max', Number(e.target.value))}
                  />
                </Field>
              </div>
              <Button
                variant="outline"
                disabled={draft.questions.length === 1}
                onClick={() =>
                  setDraft({ ...draft, questions: draft.questions.filter((_, n) => n !== i) })
                }
              >
                {t('assess.remove')}
              </Button>
            </fieldset>
          ))}
          <Button
            variant="outline"
            disabled={draft.questions.length >= 20}
            onClick={() =>
              setDraft({
                ...draft,
                questions: [
                  ...draft.questions,
                  {
                    id: 'q' + crypto.randomUUID().replaceAll('-', '').slice(0, 20),
                    label: '',
                    labelHi: '',
                    min: 0,
                    max: 10,
                  },
                ],
              })
            }
          >
            {t('assess.add')}
          </Button>
        </fieldset>
        <Button disabled={busy} onClick={() => void publish()}>
          {recovering ? t('assess.retry') : t('assess.publish')}
        </Button>
      </Surface>
      <h2 className="text-xl font-bold">{t('assess.catalog')}</h2>
      {rows.length === 0 && <p>{t('assess.noForms')}</p>}
      {rows.map((r) => (
        <Surface key={r.id} className="space-y-3 p-5">
          <h3 className="font-bold">{r.definition.title}</h3>
          <p>
            {r.definition.questions.length} {t('assess.questions')} ·{' '}
            {r.active ? t('assess.active') : t('assess.archived')}
          </p>
          <details>
            <summary className="cursor-pointer">{t('assess.preview')}</summary>
            <p>{r.definition.instructions}</p>
            <ol className="list-inside list-decimal">
              {r.definition.questions.map((q) => (
                <li key={q.id}>
                  {q.label} ({q.min}–{q.max})
                </li>
              ))}
            </ol>
          </details>
          {r.active && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api.request('POST', `/assessment-forms/${r.id}/archive`, {
                    schema: AssessmentForm,
                  });
                  await load();
                } catch {
                  setError(t('assess.error'));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t('assess.archive')}
            </Button>
          )}
        </Surface>
      ))}
      {cursor && <Button onClick={() => void load(cursor)}>{t('assess.more')}</Button>}
    </section>
  );
}
