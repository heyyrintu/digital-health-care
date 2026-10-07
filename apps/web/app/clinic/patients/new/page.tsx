'use client';

import { ApiError } from '@dhc/api-client';
import {
  DuplicateCheckResponse,
  PatientDetail,
  TagList as TagListResponse,
  UhidSettings,
  type CreatePatientBody,
  type PatientSummary,
  type Tag,
} from '@dhc/contracts';
import { Button, PageHeader, Surface } from '@dhc/ui-web';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { AgeGender } from '../../patient-bits';
import { PatientForm } from '../../patient-form';
import { TagPicker } from '../../patient-tags';
import { useSession } from '../../session-provider';
import { ClinicShell, canRegister, canTag } from '../../shell';

/** Walk-in or phone registration: check for an existing record first, then assign a UHID. */
export default function RegisterPatientPage() {
  return (
    <ClinicShell>
      {(me) => (canRegister(me.role) ? <RegisterForm tagging={canTag(me.role)} /> : <NotAllowed />)}
    </ClinicShell>
  );
}

function NotAllowed() {
  const { t } = useSession();
  return (
    <p className="alert rounded-xl bg-danger-soft px-4 py-3 text-sm text-destructive">
      {t('common.notAllowed')}
    </p>
  );
}

function RegisterForm({ tagging }: { tagging: boolean }) {
  const { api, signOut, t } = useSession();
  const router = useRouter();
  const [tags, setTags] = useState<Tag[]>([]);
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [nextUhid, setNextUhid] = useState<string | null>(null);
  const [pending, setPending] = useState<CreatePatientBody | null>(null);
  const [duplicates, setDuplicates] = useState<PatientSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .request('GET', '/uhid-settings', { schema: UhidSettings })
      .then((s) => setNextUhid(s.nextUhid))
      .catch(() => undefined);
    if (tagging) {
      api
        .request('GET', '/tags', { schema: TagListResponse })
        .then((list) => setTags(list.data))
        .catch(() => undefined);
    }
  }, [api, tagging]);

  async function create(body: CreatePatientBody) {
    const created = await api.request('POST', '/patients', { schema: PatientDetail, body });
    router.push(`/clinic/patients/${created.id}`);
  }

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return void signOut('expired');
      setError(e instanceof ApiError ? e.message : t('error.network'));
    } finally {
      setBusy(false);
    }
  }

  const submit = (fields: Omit<CreatePatientBody, 'allowDuplicate' | 'tagIds'>) =>
    run(async () => {
      const body: CreatePatientBody = {
        ...fields,
        tagIds: tagIds.length > 0 ? tagIds : undefined,
        allowDuplicate: false,
      };
      // Front desk sees likely duplicates before a second record is created.
      const check = await api.request('POST', '/patients/duplicate-check', {
        schema: DuplicateCheckResponse,
        body: { name: body.name, phone: body.phone, dob: body.dob },
      });
      if (check.candidates.length > 0) {
        setPending(body);
        setDuplicates(check.candidates);
        return;
      }
      await create(body);
    });

  return (
    <section aria-labelledby="register-title" className="mx-auto max-w-3xl">
      <p className="mb-3">
        <Link
          href="/clinic"
          className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-primary hover:underline"
        >
          <ArrowLeft className="size-4" aria-hidden />
          {t('patient.back')}
        </Link>
      </p>
      <PageHeader
        title={<span id="register-title">{t('patient.registerTitle')}</span>}
        sub={nextUhid ? t('patient.uhidNext', { uhid: nextUhid }) : undefined}
      />

      {duplicates && pending ? (
        <Surface
          className="mb-4 border-l-4 border-l-warning p-4 sm:p-6"
          role="alert"
          data-testid="duplicates"
        >
          <h2 className="font-display text-lg font-bold">{t('patient.duplicatesTitle')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('patient.duplicatesHelp')}</p>
          <ul className="pick-list mt-4 grid list-none gap-2 p-0">
            {duplicates.map((d) => (
              <li
                key={d.id}
                className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-xl border border-border bg-card px-3 py-2"
              >
                <span className="min-w-0">
                  <strong>{d.name}</strong> · <span className="tabular">{d.uhid}</span> ·{' '}
                  <AgeGender patient={d} /> · <span className="tabular">{d.phone ?? '—'}</span>
                </span>{' '}
                <Link
                  href={`/clinic/patients/${d.id}`}
                  className="inline-flex min-h-11 items-center text-sm font-semibold text-primary hover:underline"
                >
                  {t('patient.open')}
                </Link>
              </li>
            ))}
          </ul>
          <div className="confirm-actions mt-4 flex flex-wrap gap-2">
            <Button
              type="button"
              disabled={busy}
              onClick={() => void run(() => create({ ...pending, allowDuplicate: true }))}
            >
              {t('patient.registerAnyway')}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setDuplicates(null);
                setPending(null);
              }}
            >
              {t('common.cancel')}
            </Button>
          </div>
        </Surface>
      ) : null}

      {error && (
        <p
          role="alert"
          className="alert mb-4 rounded-xl bg-danger-soft px-4 py-3 text-sm text-destructive"
          id="register-error"
        >
          {error}
        </p>
      )}

      <Surface className="p-4 sm:p-6" hidden={Boolean(duplicates)}>
        <PatientForm submitLabel={t('patient.register')} busy={busy} onSubmit={submit}>
          {tagging && <TagPicker tags={tags} selected={tagIds} onChange={setTagIds} />}
        </PatientForm>
      </Surface>
    </section>
  );
}
