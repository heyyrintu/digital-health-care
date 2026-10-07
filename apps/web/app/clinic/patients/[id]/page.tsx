'use client';

import { ApiError } from '@dhc/api-client';
import {
  AppointmentList,
  PatientDetail,
  type Appointment,
  TagList as TagListResponse,
  type CreatePatientBody,
  type Tag,
} from '@dhc/contracts';
import { formatIstDateTime } from '@dhc/domain';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { AgeGender } from '../../patient-bits';
import { PatientForm } from '../../patient-form';
import { TagList, TagPicker } from '../../patient-tags';
import { useSession } from '../../session-provider';
import { ClinicShell, canRegister, canTag } from '../../shell';

/** Patient demographics, tags and family. No clinical content: front desk sees all of it. */
export default function PatientPage() {
  return <ClinicShell>{(me) => <PatientView role={me.role} />}</ClinicShell>;
}

function PatientView({ role }: { role: string }) {
  const { id } = useParams<{ id: string }>();
  const { api, locale, signOut, t } = useSession();
  const [patient, setPatient] = useState<PatientDetail | null>(null);
  const [tags, setTags] = useState<Tag[]>([]);
  const [appointments, setAppointments] = useState<Appointment[] | null>(null);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const show = useCallback((p: PatientDetail) => {
    setPatient(p);
    setSelectedTags(p.tags.map((tag) => tag.id));
  }, []);

  const handle = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) return void signOut('expired');
      setError(e instanceof ApiError ? e.message : t('error.network'));
    },
    [signOut, t],
  );

  useEffect(() => {
    api
      .request('GET', `/patients/${encodeURIComponent(id)}`, { schema: PatientDetail })
      .then(show)
      .catch(handle);
    api
      .request('GET', '/appointments', { schema: AppointmentList, query: { patientId: id } })
      .then((list) => setAppointments(list.data))
      .catch(() => setAppointments([]));
    if (canTag(role)) {
      api
        .request('GET', '/tags', { schema: TagListResponse })
        .then((list) => setTags(list.data))
        .catch(() => undefined);
    }
  }, [api, id, role, show, handle]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      await action();
    } catch (e) {
      handle(e);
    } finally {
      setBusy(false);
    }
  }

  const saveTags = () =>
    run(async () => {
      show(
        await api.request('PUT', `/patients/${id}/tags`, {
          schema: PatientDetail,
          body: { tagIds: selectedTags },
        }),
      );
      setSaved('tags');
    });

  const saveDetails = (body: Omit<CreatePatientBody, 'allowDuplicate' | 'tagIds'>) =>
    run(async () => {
      show(await api.request('PATCH', `/patients/${id}`, { schema: PatientDetail, body }));
      setEditing(false);
      setSaved('details');
    });

  if (!patient) {
    return (
      <section className="card">
        <p>
          <Link href="/clinic">{t('patient.back')}</Link>
        </p>
        {error ? (
          <p role="alert" className="alert">
            {error}
          </p>
        ) : (
          <p aria-live="polite">{t('common.loading')}</p>
        )}
      </section>
    );
  }

  const tagsChanged =
    [...selectedTags].sort().join() !==
    patient.tags
      .map((tag) => tag.id)
      .sort()
      .join();

  return (
    <>
      <section aria-labelledby="patient-title" className="card">
        <p>
          <Link href="/clinic">{t('patient.back')}</Link>
        </p>
        <h1 id="patient-title">{patient.name}</h1>
        <p className="patient-meta" data-testid="patient-meta">
          <span data-testid="patient-uhid">{patient.uhid}</span> · <AgeGender patient={patient} /> ·{' '}
          {patient.phone ?? '—'}
        </p>
        <p className="hint">
          {t('patient.registeredOn', { date: formatIstDateTime(patient.createdAt, locale) })}
        </p>
        <p data-testid="patient-tags">
          <TagList tags={patient.tags} />
        </p>
        {error && (
          <p role="alert" className="alert">
            {error}
          </p>
        )}
        {saved && (
          <p role="status" className="notice">
            {t('patient.saved')}
          </p>
        )}
        {canTag(role) && tags.length > 0 && (
          <div className="tag-editor">
            <TagPicker tags={tags} selected={selectedTags} onChange={setSelectedTags} />
            <button
              type="button"
              className="primary"
              disabled={busy || !tagsChanged}
              onClick={() => void saveTags()}
            >
              {t('patient.saveTags')}
            </button>
          </div>
        )}
      </section>

      <section aria-labelledby="details-title" className="card">
        <div className="card-header">
          <h2 id="details-title">{t('patient.details')}</h2>
          {canRegister(role) && !editing && (
            <button type="button" className="secondary" onClick={() => setEditing(true)}>
              {t('patient.edit')}
            </button>
          )}
        </div>
        {editing ? (
          <PatientForm
            initial={patient}
            submitLabel={t('common.save')}
            busy={busy}
            onSubmit={saveDetails}
          >
            <div className="field wide">
              <button type="button" className="secondary" onClick={() => setEditing(false)}>
                {t('common.cancel')}
              </button>
            </div>
          </PatientForm>
        ) : (
          <dl className="details">
            <Row label={t('patient.dob')} value={patient.dob} />
            <Row label={t('patient.email')} value={patient.email} />
            <Row label={t('patient.address')} value={patient.address} />
            <Row label={t('patient.bloodGroup')} value={patient.bloodGroup} />
            <Row label={t('patient.language')} value={t(`language.${patient.language}`)} />
            <Row label={t('patient.emergencyName')} value={patient.emergencyContactName} />
            <Row label={t('patient.emergencyPhone')} value={patient.emergencyContactPhone} />
            <Row
              label={t('patient.guardian')}
              value={
                patient.guardian ? `${patient.guardian.name} · ${patient.guardian.uhid}` : null
              }
            />
          </dl>
        )}
      </section>

      <section aria-labelledby="patient-appointments-title" className="card">
        <div className="card-header">
          <h2 id="patient-appointments-title">{t('patient.appointments')}</h2>
          {canRegister(role) && (
            <Link className="button-link" href={`/clinic/appointments/new?patientId=${patient.id}`}>
              {t('patient.book')}
            </Link>
          )}
        </div>
        {appointments && appointments.length === 0 && <p>{t('patient.noAppointments')}</p>}
        {appointments && appointments.length > 0 && (
          <ul className="pick-list" data-testid="patient-appointments">
            {appointments.map((a) => (
              <li key={a.id}>
                <Link href={`/clinic/appointments?date=${a.date}`}>
                  {t('appointments.at', { date: a.date, time: a.startTime })}
                </Link>{' '}
                · {a.doctorName ?? t('availability.doctor')} · {a.consultationTypeName}
                <span className="pill">{t(`status.${a.status}`)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="family-title" className="card">
        <h2 id="family-title">{t('patient.family')}</h2>
        {patient.family.length === 0 ? (
          <p>{t('patient.noFamily')}</p>
        ) : (
          <ul className="pick-list" data-testid="family">
            {patient.family.map((f) => (
              <li key={f.id}>
                <Link href={`/clinic/patients/${f.id}`}>{f.name}</Link> · {f.uhid} ·{' '}
                {t(`relation.${f.relation}`)}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function Row({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value ?? '—'}</dd>
    </div>
  );
}
