'use client';
import {
  AssessmentForms,
  PatientAssessments,
  PatientAssessment,
  type AssessmentForm,
} from '@dhc/contracts';
import { Button, Field, NativeSelect, Surface } from '@dhc/ui-web';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ClinicShell, NotAllowed } from '../../../shell';
import { useSession } from '../../../session-provider';
export default function Page() {
  const { id } = useParams<{ id: string }>();
  return (
    <ClinicShell>
      {(me) => (me.role === 'doctor' ? <History key={id} id={id} /> : <NotAllowed />)}
    </ClinicShell>
  );
}
function History({ id }: { id: string }) {
  const { api, t, locale } = useSession();
  const [rows, setRows] = useState<PatientAssessment[]>([]),
    [forms, setForms] = useState<AssessmentForm[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [formCursor, setFormCursor] = useState<string | null>(null),
    [chosen, setChosen] = useState(''),
    [filter, setFilter] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [recovering, setRecovering] = useState(false);
  const attempt = useRef<{ id: string; formId: string } | null>(null);
  const load = useCallback(
    async (next?: string) => {
      try {
        const r = await api.request(
          'GET',
          `/patients/${id}/assessments` + (next ? '?cursor=' + next : ''),
          { schema: PatientAssessments },
        );
        setRows((old) => (next ? [...old, ...r.data] : r.data));
        setCursor(r.nextCursor);
      } catch {
        setError(t('assess.error'));
      } finally {
        setLoading(false);
      }
    },
    [api, id, t],
  );
  const loadForms = useCallback(
    async (next?: string) => {
      try {
        const r = await api.request('GET', '/assessment-forms' + (next ? '?cursor=' + next : ''), {
          schema: AssessmentForms,
        });
        setForms((old) => (next ? [...old, ...r.data] : r.data));
        setFormCursor(r.nextCursor);
      } catch {
        setError(t('assess.error'));
      }
    },
    [api, t],
  );
  useEffect(() => {
    void load();
    void loadForms();
  }, [load, loadForms]);
  async function assign() {
    if (!chosen && !attempt.current) return;
    setError('');
    setBusy(true);
    setRecovering(true);
    const body = attempt.current ?? { id: crypto.randomUUID(), formId: chosen };
    attempt.current = body;
    try {
      await api.request('POST', `/patients/${id}/assessments`, { schema: PatientAssessment, body });
      attempt.current = null;
      setRecovering(false);
      await load();
    } catch {
      setError(t('assess.retrySame'));
    } finally {
      setBusy(false);
    }
  }
  const visible = rows
    .filter((r) => !filter || r.formId === filter)
    .sort((a, b) => (a.submittedAt ?? a.createdAt).localeCompare(b.submittedAt ?? b.createdAt));
  const label = (r: PatientAssessment) =>
    locale === 'hi' && r.definition.titleHi ? r.definition.titleHi : r.definition.title;
  return (
    <section className="space-y-5">
      <Link href={`/clinic/patients/${id}`} className="underline">
        {t('assess.back')}
      </Link>
      <h1 className="text-2xl font-bold">{t('assess.title')}</h1>
      <p>{t('assess.scope')}</p>
      {error && <p role="alert">{error}</p>}
      <Surface className="space-y-4 p-5">
        <h2 className="text-xl font-bold">{t('assess.assign')}</h2>
        <Field label={t('assess.form')}>
          <NativeSelect
            disabled={busy || recovering}
            value={chosen}
            onChange={(e) => setChosen(e.target.value)}
          >
            <option value="">{t('assess.choose')}</option>
            {forms
              .filter((f) => f.active)
              .map((f) => (
                <option key={f.id} value={f.id}>
                  {f.definition.title}
                </option>
              ))}
          </NativeSelect>
        </Field>
        {formCursor && (
          <Button variant="outline" onClick={() => void loadForms(formCursor)}>
            {t('assess.moreForms')}
          </Button>
        )}
        <Button disabled={busy || (!chosen && !recovering)} onClick={() => void assign()}>
          {recovering ? t('assess.retry') : t('assess.assign')}
        </Button>
        <p>
          <Link href="/clinic/assessments" className="underline">
            {t('assess.manage')}
          </Link>
        </p>
      </Surface>
      <h2 className="text-xl font-bold">{t('assess.history')}</h2>
      <p>{t('assess.compare')}</p>
      <Field label={t('assess.filter')}>
        <NativeSelect value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">{t('assess.all')}</option>
          {[...new Map(rows.map((r) => [r.formId, r])).values()].map((r) => (
            <option key={r.formId} value={r.formId}>
              {label(r)} · {new Date(r.createdAt).toLocaleDateString()}
            </option>
          ))}
        </NativeSelect>
      </Field>
      {filter && visible.filter((r) => r.result).length >= 2 && (
        <Surface className="space-y-3 p-4">
          <svg
            viewBox="0 0 600 180"
            role="img"
            aria-label={t('assess.history')}
            className="w-full text-primary"
          >
            <title>{t('assess.history')}</title>
            <line x1="30" y1="155" x2="570" y2="155" stroke="currentColor" opacity="0.25" />
            <polyline
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              points={visible
                .filter((r) => r.result)
                .map(
                  (r, i, all) =>
                    `${30 + (i * 540) / (all.length - 1)},${155 - (125 * (r.result!.total - r.result!.minimum)) / (r.result!.maximum - r.result!.minimum)}`,
                )
                .join(' ')}
            />
            {visible
              .filter((r) => r.result)
              .map((r, i, all) => (
                <g key={r.id}>
                  <circle
                    cx={30 + (i * 540) / (all.length - 1)}
                    cy={
                      155 -
                      (125 * (r.result!.total - r.result!.minimum)) /
                        (r.result!.maximum - r.result!.minimum)
                    }
                    r="5"
                    fill="currentColor"
                  />
                  <text
                    x={30 + (i * 540) / (all.length - 1)}
                    y={Math.max(
                      16,
                      145 -
                        (125 * (r.result!.total - r.result!.minimum)) /
                          (r.result!.maximum - r.result!.minimum),
                    )}
                    textAnchor="middle"
                    fill="currentColor"
                    fontSize="16"
                  >
                    {r.result!.total}
                  </text>
                </g>
              ))}
          </svg>
          <p className="text-sm">{t('assess.compare')}</p>
        </Surface>
      )}
      {loading && <p>{t('common.loading')}</p>}
      {!loading && !rows.length && <p>{t('assess.empty')}</p>}
      {visible.map((r) => (
        <Surface key={r.id} className="space-y-3 p-5">
          <h3 className="font-semibold">{label(r)}</h3>
          <p>
            {t(`assess.${r.state}`)} ·{' '}
            {new Date(r.submittedAt ?? r.createdAt).toLocaleString(
              locale === 'hi' ? 'hi-IN' : 'en-IN',
            )}
          </p>
          {r.result && (
            <>
              <p>
                {t('assess.score')}: {r.result.total} ({r.result.minimum}–{r.result.maximum})
              </p>
              <details>
                <summary>{t('assess.answers')}</summary>
                <dl>
                  {r.definition.questions.map((q) => (
                    <div key={q.id}>
                      <dt>{locale === 'hi' && q.labelHi ? q.labelHi : q.label}</dt>
                      <dd>{r.result!.answers[q.id]}</dd>
                    </div>
                  ))}
                </dl>
              </details>
            </>
          )}
          {r.state === 'pending' && (
            <Button
              disabled={busy}
              variant="outline"
              onClick={async () => {
                setBusy(true);
                try {
                  await api.request('POST', `/assessments/${r.id}/cancel`, {
                    schema: PatientAssessment,
                  });
                  await load();
                } catch {
                  setError(t('assess.error'));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t('assess.cancel')}
            </Button>
          )}
        </Surface>
      ))}
      {cursor && (
        <Button disabled={busy} onClick={() => void load(cursor)}>
          {t('assess.more')}
        </Button>
      )}
      <Button
        disabled={busy}
        variant="outline"
        onClick={() => {
          setError('');
          void load();
        }}
      >
        {t('assess.reload')}
      </Button>
    </section>
  );
}
