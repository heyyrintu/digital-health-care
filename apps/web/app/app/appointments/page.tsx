'use client';

import type { PortalAppointment, PortalAppointmentList } from '@dhc/contracts';
import { shortDate } from '@dhc/domain';
import { Button, EmptyState } from '@dhc/ui-web';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { cancelOption, portalErrorMessage } from '../../../lib/patient';
import { LoadError, Loading, Notice, PortalPage } from '../parts';
import { usePatientSession } from '../session-provider';
import { PortalShell } from '../shell';

/** PRD §4.4: the family's upcoming and past appointments; cancel within the clinic's rules. */
export default function AppointmentsPage() {
  return <PortalShell>{() => <Appointments />}</PortalShell>;
}

type Load =
  | { status: 'loading' }
  | { status: 'error'; error: unknown }
  | { status: 'ready'; data: PortalAppointmentList };

function Appointments() {
  const { api, t } = usePatientSession();
  const [list, setList] = useState<Load>({ status: 'loading' });
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  // The visit asked about, then the one being cancelled until the list has refreshed: one
  // confirmation sends one request.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setList({ status: 'loading' });
      try {
        setList({ status: 'ready', data: await api.portalAppointments() });
      } catch (error) {
        setList({ status: 'error', error });
      }
    },
    [api],
  );
  useEffect(() => void load(), [load]);

  async function cancel(appointment: PortalAppointment) {
    setCancelling(appointment.id);
    setNotice(null);
    try {
      await api.cancelPortalAppointment(appointment.id);
      setNotice({ tone: 'success', text: t('patient.appts.cancelled') });
    } catch (e) {
      setNotice({ tone: 'error', text: portalErrorMessage(e, t) });
    }
    setConfirming(null);
    await load(true);
    setCancelling(null);
  }

  return (
    <PortalPage title={t('patient.nav.appointments')}>
      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
      {list.status === 'loading' && <Loading />}
      {list.status === 'error' && <LoadError error={list.error} retry={() => void load()} />}
      {list.status === 'ready' && (
        <>
          <h2 className="font-display text-lg font-bold">{t('patient.appts.upcoming')}</h2>
          <AppointmentList
            items={list.data.upcoming}
            testId="upcoming"
            actions={(a) => {
              const option = cancelOption(a);
              if (option === 'call') {
                return (
                  <p className="text-xs text-muted-foreground">{t('portal.appts.callToCancel')}</p>
                );
              }
              if (option !== 'cancel') return null;
              if (confirming !== a.id) {
                return (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={cancelling !== null}
                    onClick={() => setConfirming(a.id)}
                  >
                    {t('patient.appts.cancel')}
                  </Button>
                );
              }
              return (
                <div
                  className="space-y-3 rounded-xl bg-warning-soft p-4 text-sm text-warning-foreground"
                  role="group"
                  aria-label={t('patient.appts.cancelConfirm')}
                >
                  <p className="font-medium">{t('patient.appts.cancelConfirm')}</p>
                  <div className="flex flex-wrap gap-3">
                    <Button
                      type="button"
                      variant="destructive"
                      disabled={cancelling !== null}
                      onClick={() => void cancel(a)}
                    >
                      {t('patient.appts.cancel')}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={cancelling !== null}
                      onClick={() => setConfirming(null)}
                    >
                      {t('patient.appts.keep')}
                    </Button>
                  </div>
                </div>
              );
            }}
          />
          <h2 className="font-display text-lg font-bold">{t('patient.appts.past')}</h2>
          <AppointmentList items={list.data.past} testId="past" />
        </>
      )}
    </PortalPage>
  );
}

function AppointmentList({
  items,
  testId,
  actions,
}: {
  items: PortalAppointment[];
  testId: string;
  actions?: (a: PortalAppointment) => ReactNode;
}) {
  const { locale, t } = usePatientSession();
  if (items.length === 0) return <EmptyState title={t('patient.appts.none')} />;
  return (
    <ul className="space-y-3" data-testid={testId}>
      {items.map((a) => (
        <li key={a.id} className="surface space-y-1 p-4 text-sm" data-testid="appointment">
          <p className="font-display text-base font-bold">{a.patient.name}</p>
          <p className="font-medium">
            {shortDate(a.date, locale)} · <span className="tabular">{a.startTime}</span> ·{' '}
            {t(`status.${a.status}`)}
          </p>
          <p className="text-muted-foreground">
            {a.doctorName
              ? t('patient.home.with', { doctor: a.doctorName, clinic: a.clinicName })
              : a.clinicName}
          </p>
          <p className="text-muted-foreground">
            {a.consultationTypeName} · {t('queue.token', { token: a.tokenNumber })}
          </p>
          {a.prescription && (
            <p className="text-muted-foreground">
              {t('patient.appts.prescription', { number: a.prescription.number })}
              {a.prescription.status === 'void' && (
                <span className="ml-2 font-medium text-destructive">{t('patient.rx.void')}</span>
              )}
            </p>
          )}
          {actions && <div className="pt-2">{actions(a)}</div>}
        </li>
      ))}
    </ul>
  );
}
