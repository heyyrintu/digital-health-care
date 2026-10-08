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
import { Button, PageHeader, StatusChip, Surface, buttonVariants } from '@dhc/ui-web';
import { ArrowLeft, CalendarPlus, Pencil } from 'lucide-react';
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

  const back = (
    <p className="mb-3">
      <Link
        href="/clinic"
        className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-primary hover:underline"
      >
        <ArrowLeft className="size-4" aria-hidden />
        {t('patient.back')}
      </Link>
    </p>
  );

  if (!patient) {
    return (
      <section>
        {back}
        <Surface className="p-4 sm:p-6">
          {error ? (
            <p
              role="alert"
              className="alert rounded-xl bg-danger-soft px-4 py-3 text-sm text-destructive"
            >
              {error}
            </p>
          ) : (
            <p aria-live="polite" className="text-sm text-muted-foreground">
              {t('common.loading')}
            </p>
          )}
        </Surface>
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
    <div className="grid gap-4 sm:gap-6">
      <section aria-labelledby="patient-title">
        {back}
        <PageHeader
          titleId="patient-title"
          title={patient.name}
          sub={
            <>
              <span
                className="patient-meta block text-base text-foreground"
                data-testid="patient-meta"
              >
                <span data-testid="patient-uhid" className="tabular font-semibold">
                  {patient.uhid}
                </span>{' '}
                · <AgeGender patient={patient} /> ·{' '}
                <span className="tabular">{patient.phone ?? '—'}</span>
              </span>
              <span className="mt-1 block">
                {t('patient.registeredOn', { date: formatIstDateTime(patient.createdAt, locale) })}
              </span>
            </>
          }
          actions={
            canRegister(role) ? (
              <Link
                className={buttonVariants()}
                href={`/clinic/appointments/new?patientId=${patient.id}`}
              >
                <CalendarPlus aria-hidden />
                {t('patient.book')}
              </Link>
            ) : undefined
          }
        />
        <Surface className="grid gap-4 p-4 sm:p-6">
          <p data-testid="patient-tags" className="flex flex-wrap gap-1.5">
            <TagList tags={patient.tags} />
          </p>
          {error && (
            <p
              role="alert"
              className="alert rounded-xl bg-danger-soft px-4 py-3 text-sm text-destructive"
            >
              {error}
            </p>
          )}
          {saved && (
            <p
              role="status"
              className="notice rounded-xl bg-success-soft px-4 py-3 text-sm text-success"
            >
              {t('patient.saved')}
            </p>
          )}
          {canTag(role) && tags.length > 0 && (
            <div className="tag-editor grid justify-items-start gap-3">
              <TagPicker tags={tags} selected={selectedTags} onChange={setSelectedTags} />
              <Button type="button" disabled={busy || !tagsChanged} onClick={() => void saveTags()}>
                {t('patient.saveTags')}
              </Button>
            </div>
          )}
        </Surface>
      </section>

      <Surface className="p-4 sm:p-6">
        <section aria-labelledby="details-title">
          <div className="card-header mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 id="details-title" className="font-display text-lg font-bold">
              {t('patient.details')}
            </h2>
            {canRegister(role) && !editing && (
              <Button type="button" variant="outline" onClick={() => setEditing(true)}>
                <Pencil aria-hidden />
                {t('patient.edit')}
              </Button>
            )}
          </div>
          {editing ? (
            <PatientForm
              initial={patient}
              submitLabel={t('common.save')}
              busy={busy}
              onSubmit={saveDetails}
            >
              <div className="field wide sm:col-span-2">
                <Button type="button" variant="outline" onClick={() => setEditing(false)}>
                  {t('common.cancel')}
                </Button>
              </div>
            </PatientForm>
          ) : (
            <dl className="details m-0 grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
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
      </Surface>

      <div className="grid gap-4 sm:gap-6 lg:grid-cols-2">
        <Surface className="p-4 sm:p-6">
          <section aria-labelledby="patient-appointments-title">
            <div className="card-header mb-4 flex flex-wrap items-center justify-between gap-3">
              <h2 id="patient-appointments-title" className="font-display text-lg font-bold">
                {t('patient.appointments')}
              </h2>
            </div>
            {appointments && appointments.length === 0 && (
              <p className="text-sm text-muted-foreground">{t('patient.noAppointments')}</p>
            )}
            {appointments && appointments.length > 0 && (
              <ul
                className="pick-list m-0 grid list-none gap-2 p-0"
                data-testid="patient-appointments"
              >
                {appointments.map((a) => (
                  <li
                    key={a.id}
                    className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-xl border border-border px-3 py-2"
                  >
                    <span className="min-w-0">
                      <Link
                        href={`/clinic/queue?date=${a.date}`}
                        className="tabular font-semibold text-primary hover:underline"
                      >
                        {t('appointments.at', { date: a.date, time: a.startTime })}
                      </Link>{' '}
                      <span className="text-sm text-muted-foreground">
                        · {a.doctorName ?? t('availability.doctor')} · {a.consultationTypeName}
                      </span>
                    </span>
                    <StatusChip status={a.status} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </Surface>

        <Surface className="p-4 sm:p-6">
          <section aria-labelledby="family-title">
            <h2 id="family-title" className="mb-4 font-display text-lg font-bold">
              {t('patient.family')}
            </h2>
            {patient.family.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('patient.noFamily')}</p>
            ) : (
              <ul className="pick-list m-0 grid list-none gap-2 p-0" data-testid="family">
                {patient.family.map((f) => (
                  <li
                    key={f.id}
                    className="flex min-h-11 flex-wrap items-center gap-x-2 rounded-xl border border-border px-3 py-2"
                  >
                    <Link
                      href={`/clinic/patients/${f.id}`}
                      className="font-semibold text-primary hover:underline"
                    >
                      {f.name}
                    </Link>{' '}
                    <span className="text-sm text-muted-foreground">
                      · <span className="tabular">{f.uhid}</span> · {t(`relation.${f.relation}`)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </Surface>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="m-0 mt-1 break-words [overflow-wrap:anywhere]">{value ?? '—'}</dd>
    </div>
  );
}
