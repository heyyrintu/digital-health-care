'use client';
import { PatientAssessments, PatientAssessment } from '@dhc/contracts';
import { Button, Field, NativeSelect, Surface } from '@dhc/ui-web';
import { useCallback, useEffect, useRef, useState } from 'react';
import { PortalShell, type ReadyAccount } from '../shell';
import { PortalPage, PatientPicker } from '../parts';
import { usePatientSession } from '../session-provider';
export default function Page() {
  return (
    <PortalShell>
      {(account) => <Assessments key={account.selected.id} account={account} />}
    </PortalShell>
  );
}
function Assessments({ account }: { account: ReadyAccount }) {
  const { api, t, locale } = usePatientSession();
  const [rows, setRows] = useState<PatientAssessment[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true);
  const load = useCallback(
    async (next?: string) => {
      try {
        const r = await api.request(
          'GET',
          `/portal/patients/${account.selected.id}/assessments` + (next ? '?cursor=' + next : ''),
          { schema: PatientAssessments },
        );
        setRows((old) => (next ? [...old, ...r.data] : r.data));
        setCursor(r.nextCursor);
        setError('');
      } catch {
        setError(t('assess.error'));
      } finally {
        setLoading(false);
      }
    },
    [api, account.selected.id, t],
  );
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <PortalPage title={t('assess.title')} intro={t('assess.scope')}>
      <PatientPicker
        label={t('patient.book.for')}
        patients={account.patients}
        selectedId={account.selected.id}
        onSelect={account.select}
      />
      {error && (
        <p role="alert">
          {error}
          <Button onClick={() => void load()}>{t('assess.reload')}</Button>
        </p>
      )}
      {loading && <p>{t('common.loading')}</p>}
      {!loading && !error && !rows.length && <p>{t('assess.empty')}</p>}
      {rows.map((r) => (
        <Response key={r.id} row={r} busy={busy} setBusy={setBusy} reload={load} locale={locale} />
      ))}
      {cursor && (
        <Button disabled={busy} onClick={() => void load(cursor)}>
          {t('assess.more')}
        </Button>
      )}
    </PortalPage>
  );
}
function Response({
  row,
  busy,
  setBusy,
  reload,
  locale,
}: {
  row: PatientAssessment;
  busy: boolean;
  setBusy: (v: boolean) => void;
  reload: () => Promise<void>;
  locale: string;
}) {
  const { api, t } = usePatientSession();
  const [answers, setAnswers] = useState<Record<string, number>>({}),
    [error, setError] = useState(''),
    [locked, setLocked] = useState(false);
  const attempt = useRef<Record<string, number> | null>(null),
    [done, setDone] = useState(false);
  const text = (en: string, hi: string) => (locale === 'hi' && hi ? hi : en);
  async function submit() {
    setError('');
    const data = attempt.current ?? answers;
    if (row.definition.questions.some((q) => data[q.id] === undefined)) {
      setError(t('assess.answerAll'));
      return;
    }
    attempt.current = { ...data };
    setLocked(true);
    setBusy(true);
    try {
      await api.request('POST', `/portal/assessments/${row.id}/submit`, {
        schema: PatientAssessment,
        body: { answers: data },
      });
      setDone(true);
      await reload();
    } catch {
      setError(t('assess.retrySame'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Surface className="space-y-4 p-5">
      <h2 className="text-xl font-bold">{text(row.definition.title, row.definition.titleHi)}</h2>
      <p>{text(row.definition.instructions, row.definition.instructionsHi)}</p>
      <p>{t(`assess.${row.state}`)}</p>
      {error && <p role="alert">{error}</p>}
      {row.result ? (
        <>
          <p className="font-semibold">
            {t('assess.score')}: {row.result.total} ({row.result.minimum}–{row.result.maximum})
          </p>
          <p>{new Date(row.submittedAt!).toLocaleString(locale === 'hi' ? 'hi-IN' : 'en-IN')}</p>
          <dl>
            {row.definition.questions.map((q) => (
              <div key={q.id}>
                <dt>{text(q.label, q.labelHi)}</dt>
                <dd>{row.result!.answers[q.id]}</dd>
              </div>
            ))}
          </dl>
        </>
      ) : row.state === 'pending' && !done ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="space-y-4"
        >
          <fieldset disabled={busy || locked} className="space-y-4">
            {row.definition.questions.map((q) => (
              <Field key={q.id} label={text(q.label, q.labelHi)}>
                <NativeSelect
                  value={answers[q.id] ?? ''}
                  required
                  onChange={(e) => setAnswers({ ...answers, [q.id]: Number(e.target.value) })}
                >
                  <option value="">{t('assess.choose')}</option>
                  {Array.from({ length: q.max - q.min + 1 }, (_, i) => q.min + i).map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            ))}
          </fieldset>
          <p>{t('assess.final')}</p>
          <Button disabled={busy} type="submit">
            {locked ? t('assess.retry') : t('assess.submit')}
          </Button>
        </form>
      ) : done ? (
        <p role="status">{t('assess.submitted')}</p>
      ) : null}
    </Surface>
  );
}
