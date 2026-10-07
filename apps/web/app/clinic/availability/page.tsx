'use client';

import { ApiError } from '@dhc/api-client';
import {
  ClinicList,
  ConsultationTypeList,
  DoctorList,
  type Clinic,
  type ConsultationType,
  type Doctor,
  type MeResponse,
} from '@dhc/contracts';
import { istDateKey } from '@dhc/domain';
import { buttonVariants, Label, NativeSelect, PageHeader, Surface } from '@dhc/ui-web';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useSession } from '../session-provider';
import { ClinicShell } from '../shell';
import { ExceptionsCard } from './exceptions-card';
import { ScheduleCard } from './schedule-card';
import type { Selection } from './selection';
import { SlotPreview } from './slot-preview';

/**
 * Doctor availability (PRD §4.3): weekly schedules, leave, holidays and extra sessions,
 * and a preview of the slots they produce. Doctors manage their own; clinic admins
 * manage anyone's; front desk can check slots.
 */
export default function AvailabilityPage() {
  return (
    <ClinicShell>
      {(me) => (me.role === 'patient' ? <NotAllowed /> : <Availability me={me} />)}
    </ClinicShell>
  );
}

function NotAllowed() {
  const { t } = useSession();
  return (
    <p className="rounded-xl bg-muted p-4 text-sm text-muted-foreground">
      {t('common.notAllowed')}
    </p>
  );
}

function Availability({ me }: { me: MeResponse }) {
  const { api, signOut, t } = useSession();
  const [doctors, setDoctors] = useState<Doctor[] | null>(null);
  const [clinics, setClinics] = useState<Clinic[]>([]);
  const [types, setTypes] = useState<ConsultationType[]>([]);
  const [doctorId, setDoctorId] = useState('');
  const [clinicId, setClinicId] = useState('');
  const [typeId, setTypeId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const changed = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    Promise.all([
      api.request('GET', '/doctors', { schema: DoctorList }),
      api.request('GET', '/clinics', { schema: ClinicList }),
      api.request('GET', '/consultation-types', { schema: ConsultationTypeList }),
    ])
      .then(([d, c, ty]) => {
        const activeClinics = c.data.filter((x) => x.active);
        const activeTypes = ty.data.filter((x) => x.active);
        setDoctors(d.data);
        setClinics(activeClinics);
        setTypes(activeTypes);
        setDoctorId(me.role === 'doctor' ? me.user.id : (d.data[0]?.userId ?? ''));
        setClinicId(activeClinics[0]?.id ?? '');
        setTypeId(activeTypes[0]?.id ?? '');
      })
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 401) return void signOut('expired');
        setError(e instanceof ApiError ? e.message : t('error.network'));
      });
  }, [api, me, signOut, t]);

  const clinic = clinics.find((c) => c.id === clinicId);
  const type = types.find((ty) => ty.id === typeId);
  const isAdmin = me.role === 'clinic_admin';
  const selection: Selection | null =
    doctorId && clinic && type
      ? {
          doctorId,
          clinic,
          type,
          clinics,
          canEdit: isAdmin || (me.role === 'doctor' && doctorId === me.user.id),
          isAdmin,
          today: istDateKey(new Date()),
          version,
          changed,
        }
      : null;

  return (
    <section aria-labelledby="availability-title" className="space-y-6">
      <PageHeader
        title={<span id="availability-title">{t('availability.title')}</span>}
        actions={
          <Link href="/clinic" className={buttonVariants({ variant: 'ghost' })}>
            <ArrowLeft aria-hidden />
            {t('availability.back')}
          </Link>
        }
      />
      {error && (
        <p
          role="alert"
          className="rounded-xl bg-danger-soft p-4 text-sm font-medium text-destructive"
        >
          {error}
        </p>
      )}
      {doctors && (clinics.length === 0 || types.length === 0) && (
        <p className="rounded-xl bg-muted p-4 text-sm text-muted-foreground">
          {t('availability.needSetup')}
        </p>
      )}
      {doctors && doctors.length === 0 && me.role !== 'doctor' && (
        <p className="rounded-xl bg-muted p-4 text-sm text-muted-foreground">
          {t('availability.noDoctors')}
        </p>
      )}
      {doctors && clinics.length > 0 && types.length > 0 && (
        <Surface className="grid gap-4 p-5 sm:grid-cols-2 sm:p-6 lg:grid-cols-3">
          {me.role !== 'doctor' && doctors.length > 0 && (
            <div className="space-y-2">
              <Label htmlFor="pick-doctor">{t('availability.doctor')}</Label>
              <NativeSelect
                id="pick-doctor"
                value={doctorId}
                onChange={(e) => setDoctorId(e.target.value)}
              >
                {doctors.map((d) => (
                  <option key={d.userId} value={d.userId}>
                    {d.displayName ?? d.userId}
                  </option>
                ))}
              </NativeSelect>
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="pick-clinic">{t('availability.clinic')}</Label>
            <NativeSelect
              id="pick-clinic"
              value={clinicId}
              onChange={(e) => setClinicId(e.target.value)}
            >
              {clinics.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="space-y-2">
            <Label htmlFor="pick-type">{t('availability.type')}</Label>
            <NativeSelect id="pick-type" value={typeId} onChange={(e) => setTypeId(e.target.value)}>
              {types.map((ty) => (
                <option key={ty.id} value={ty.id}>
                  {ty.name}
                </option>
              ))}
            </NativeSelect>
          </div>
        </Surface>
      )}
      {selection && (
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)] lg:grid-rows-[auto_1fr]">
          <div className="min-w-0 lg:col-start-2 lg:row-start-1">
            <SlotPreview selection={selection} />
          </div>
          <div className="min-w-0 lg:col-start-1 lg:row-span-2 lg:row-start-1">
            <ScheduleCard
              key={`${selection.doctorId}-${selection.clinic.id}-${selection.type.id}`}
              selection={selection}
            />
          </div>
          <div className="min-w-0 lg:col-start-2 lg:row-start-2">
            <ExceptionsCard selection={selection} />
          </div>
        </div>
      )}
    </section>
  );
}
