'use client';

import { ApiError } from '@dhc/api-client';
import { PatientMergeList, PatientMergeRequest, type PatientMergeSide } from '@dhc/contracts';
import { formatIstDateTime } from '@dhc/domain';
import { Button, Chip, Field, Input, PageHeader, Surface } from '@dhc/ui-web';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useSession } from '../session-provider';
import { ClinicShell, NotAllowed } from '../shell';

const H2 = 'font-display text-lg font-bold';
const MUTED = 'text-sm text-muted-foreground';
const TH = 'py-2 pr-4 text-left text-xs font-semibold text-muted-foreground';
const TD = 'py-2 pr-4 align-top';

/** Clinic admin: merge requests for duplicate patient records (PRD §3.2). */
export default function MergesPage() {
  return (
    <ClinicShell>
      {(me) => (me.role === 'clinic_admin' ? <MergesScreen /> : <NotAllowed />)}
    </ClinicShell>
  );
}

function MergesScreen() {
  const { api, locale, signOut, t } = useSession();
  const [pending, setPending] = useState<PatientMergeRequest[] | null>(null);
  const [decided, setDecided] = useState<PatientMergeRequest[] | null>(null);
  const [open, setOpen] = useState<{ id: string; mode: 'approve' | 'reject' } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) return void signOut('expired');
      setError(e instanceof ApiError ? e.message : t('error.network'));
    },
    [signOut, t],
  );

  const latest = useRef(0);
  const load = useCallback(async () => {
    const request = ++latest.current;
    const [p, d] = await Promise.all([
      api.request('GET', '/patient-merges', { schema: PatientMergeList }),
      api.request('GET', '/patient-merges', {
        schema: PatientMergeList,
        query: { status: 'decided' },
      }),
    ]);
    if (request !== latest.current) return;
    setPending(p.data);
    setDecided(d.data);
  }, [api]);

  useEffect(() => {
    load().catch(fail);
  }, [load, fail]);

  async function decide(r: PatientMergeRequest, mode: 'approve' | 'reject', note: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.request('POST', `/patient-merges/${r.id}/${mode}`, {
        schema: PatientMergeRequest,
        body: note ? { note } : {},
      });
      setOpen(null);
      await load();
      setNotice(
        mode === 'approve'
          ? t('merge.approvedNotice', { duplicate: r.source.uhid, kept: r.target.uhid })
          : t('merge.rejectedNotice'),
      );
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  const when = (iso: string) => formatIstDateTime(iso, locale);

  return (
    <section className="space-y-5">
      <PageHeader title={t('merge.pageTitle')} sub={t('merge.pageSub')} />

      <Surface className="space-y-4 p-4 sm:p-6">
        <h2 className={H2}>{t('merge.waiting')}</h2>
        {pending && pending.length === 0 && <p className={MUTED}>{t('merge.none')}</p>}
        {pending?.map((r) => (
          <article
            key={r.id}
            data-testid={`merge-${r.source.uhid}`}
            className="space-y-3 rounded-xl border border-border p-4"
          >
            <Compare r={r} />
            <p className="text-sm">
              <strong>{t('merge.reasonLabel')}</strong> {r.reason}
            </p>
            <p className={MUTED}>
              {t('merge.requestedBy', {
                name: r.requestedByName ?? '—',
                date: when(r.requestedAt),
              })}
            </p>
            {open?.id !== r.id && (
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  disabled={busy}
                  onClick={() => setOpen({ id: r.id, mode: 'approve' })}
                >
                  {t('merge.approve')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setOpen({ id: r.id, mode: 'reject' })}
                >
                  {t('merge.reject')}
                </Button>
              </div>
            )}
            {open?.id === r.id && (
              <form
                aria-label={t(open.mode === 'approve' ? 'merge.approve' : 'merge.reject')}
                className="space-y-3"
                onSubmit={(e: FormEvent<HTMLFormElement>) => {
                  e.preventDefault();
                  const note = String(new FormData(e.currentTarget).get('note') ?? '').trim();
                  void decide(r, open.mode, note);
                }}
              >
                {open.mode === 'approve' && (
                  <p className="rounded-xl bg-warning-soft px-4 py-3 text-sm text-warning-foreground">
                    {t('merge.confirm', { duplicate: r.source.uhid, kept: r.target.uhid })}
                  </p>
                )}
                <div className="sm:w-96">
                  <Field
                    label={t(open.mode === 'approve' ? 'merge.noteOptional' : 'merge.rejectReason')}
                  >
                    <Input name="note" maxLength={300} required={open.mode === 'reject'} />
                  </Field>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" disabled={busy}>
                    {t(open.mode === 'approve' ? 'merge.confirmApprove' : 'merge.confirmReject')}
                  </Button>
                  <Button type="button" variant="outline" onClick={() => setOpen(null)}>
                    {t('common.cancel')}
                  </Button>
                </div>
              </form>
            )}
          </article>
        ))}
      </Surface>

      {notice && (
        <p role="status" className="rounded-xl bg-success-soft px-4 py-3 text-sm text-success">
          {notice}
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="rounded-xl bg-danger-soft px-4 py-3 text-sm font-medium text-destructive"
        >
          {error}
        </p>
      )}

      <Surface className="space-y-3 p-4 sm:p-6">
        <h2 className={H2}>{t('merge.decided')}</h2>
        {decided && decided.length === 0 && <p className={MUTED}>{t('merge.noneDecided')}</p>}
        {decided && decided.length > 0 && (
          <ul className="m-0 list-none divide-y divide-border/70 p-0">
            {decided.map((r) => (
              <li key={r.id} data-testid={`decided-${r.source.uhid}`} className="py-3 text-sm">
                <span className="tabular font-semibold">{r.source.uhid}</span> →{' '}
                <span className="tabular font-semibold">{r.target.uhid}</span>{' '}
                {r.status === 'approved' ? (
                  <Chip className="bg-success-soft text-success">{t('merge.statusApproved')}</Chip>
                ) : (
                  <Chip className="bg-danger-soft text-destructive">
                    {t('merge.statusRejected')}
                  </Chip>
                )}
                <span className={`block ${MUTED}`}>
                  {r.decisionNote && `${r.decisionNote} · `}
                  {t('merge.decidedBy', {
                    name: r.decidedByName ?? '—',
                    date: r.decidedAt ? when(r.decidedAt) : '',
                  })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Surface>
    </section>
  );
}

/** The two records side by side: the duplicate that closes and the record that stays. */
function Compare({ r }: { r: PatientMergeRequest }) {
  const { locale, t } = useSession();
  const rows: [string, (p: PatientMergeSide) => React.ReactNode][] = [
    [t('merge.colUhid'), (p) => <span className="tabular">{p.uhid}</span>],
    [
      t('merge.colName'),
      (p) => (
        <Link href={`/clinic/patients/${p.id}`} className="font-semibold text-primary underline">
          {p.name}
        </Link>
      ),
    ],
    [t('merge.colPhone'), (p) => <span className="tabular">{p.phone ?? '—'}</span>],
    [t('merge.colDob'), (p) => <span className="tabular">{p.dob ?? '—'}</span>],
    [t('merge.colGender'), (p) => (p.gender ? t(`gender.${p.gender}`) : '—')],
    [t('merge.colRegistered'), (p) => formatIstDateTime(p.registeredAt, locale)],
    [t('merge.colVisits'), (p) => <span className="tabular">{p.visits}</span>],
  ];
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[28rem] text-sm">
        <thead>
          <tr>
            <th className={TH} scope="col">
              <span className="sr-only">{t('merge.colField')}</span>
            </th>
            <th className={TH} scope="col">
              {t('merge.duplicate')}
            </th>
            <th className={TH} scope="col">
              {t('merge.kept')}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, cell]) => (
            <tr key={label} className="border-t border-border/70">
              <th className={`${TD} font-medium text-muted-foreground`} scope="row">
                {label}
              </th>
              <td className={TD}>{cell(r.source)}</td>
              <td className={TD}>{cell(r.target)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
