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
  return <p className="alert">{t('common.notAllowed')}</p>;
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
    <section aria-labelledby="register-title" className="card">
      <p>
        <Link href="/clinic">{t('patient.back')}</Link>
      </p>
      <h1 id="register-title">{t('patient.registerTitle')}</h1>
      {nextUhid && <p className="hint">{t('patient.uhidNext', { uhid: nextUhid })}</p>}

      {duplicates && pending ? (
        <div className="notice" role="alert" data-testid="duplicates">
          <h2>{t('patient.duplicatesTitle')}</h2>
          <p>{t('patient.duplicatesHelp')}</p>
          <ul className="pick-list">
            {duplicates.map((d) => (
              <li key={d.id}>
                <strong>{d.name}</strong> · {d.uhid} · <AgeGender patient={d} /> · {d.phone ?? '—'}{' '}
                <Link href={`/clinic/patients/${d.id}`}>{t('patient.open')}</Link>
              </li>
            ))}
          </ul>
          <div className="confirm-actions">
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => void run(() => create({ ...pending, allowDuplicate: true }))}
            >
              {t('patient.registerAnyway')}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setDuplicates(null);
                setPending(null);
              }}
            >
              {t('common.cancel')}
            </button>
          </div>
        </div>
      ) : null}

      {error && (
        <p role="alert" className="alert" id="register-error">
          {error}
        </p>
      )}

      <div hidden={Boolean(duplicates)}>
        <PatientForm submitLabel={t('patient.register')} busy={busy} onSubmit={submit}>
          {tagging && <TagPicker tags={tags} selected={tagIds} onChange={setTagIds} />}
        </PatientForm>
      </div>
    </section>
  );
}
