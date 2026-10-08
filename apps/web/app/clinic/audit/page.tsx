'use client';

import { ApiError } from '@dhc/api-client';
import { AuditListResponse, StaffMemberList, type AuditEntry } from '@dhc/contracts';
import { formatIstDateTime } from '@dhc/domain';
import { Button, Input, Label, NativeSelect, PageHeader, Surface } from '@dhc/ui-web';
import { useCallback, useEffect, useState } from 'react';
import { useSession } from '../session-provider';
import { ClinicShell, NotAllowed } from '../shell';

/** Areas of the log, by the start of their action names. */
const AREAS = [
  { prefix: 'auth.', label: 'audit.area.auth' },
  { prefix: 'staff.', label: 'audit.area.staff' },
  { prefix: 'patient.', label: 'audit.area.patient' },
  { prefix: 'appointment.', label: 'audit.area.appointment' },
  { prefix: 'chart.', label: 'audit.area.chart' },
  { prefix: 'consultation.', label: 'audit.area.consultation' },
  { prefix: 'vitals.', label: 'audit.area.vitals' },
  { prefix: 'prescription.', label: 'audit.area.prescription' },
  { prefix: 'bill.', label: 'audit.area.bill' },
  { prefix: 'payment.', label: 'audit.area.payment' },
  { prefix: 'receipt.', label: 'audit.area.receipt' },
  { prefix: 'settings.', label: 'audit.area.settings' },
] as const;

const TH = 'px-3 py-2 text-left text-xs font-semibold text-muted-foreground';

interface Filters {
  action: string;
  actorUserId: string;
  from: string;
  to: string;
}

const NO_FILTERS: Filters = { action: '', actorUserId: '', from: '', to: '' };

/** Clinic admin: who did what and when (PRD §9.2). Records are named by ID, never by patient. */
export default function AuditPage() {
  return (
    <ClinicShell>
      {(me) => (me.role === 'clinic_admin' ? <AuditScreen /> : <NotAllowed />)}
    </ClinicShell>
  );
}

function AuditScreen() {
  const { api, locale, signOut, t } = useSession();
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [staff, setStaff] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) return void signOut('expired');
      setError(e instanceof ApiError ? e.message : t('error.network'));
    },
    [signOut, t],
  );

  const fetchPage = useCallback(
    (f: Filters, cursor?: string) =>
      api.request('GET', '/audit-log', {
        schema: AuditListResponse,
        query: {
          limit: 50,
          cursor,
          action: f.action || undefined,
          actorUserId: f.actorUserId || undefined,
          from: f.from || undefined,
          to: f.to || undefined,
        },
      }),
    [api],
  );

  useEffect(() => {
    api
      .request('GET', '/staff/members', { schema: StaffMemberList })
      .then((list) =>
        setStaff(list.data.map((m) => ({ id: m.userId, name: m.displayName ?? m.identifier }))),
      )
      .catch(() => undefined);
  }, [api]);

  useEffect(() => {
    let current = true;
    setError(null);
    setEntries(null);
    fetchPage(filters)
      .then((page) => {
        if (!current) return;
        setEntries(page.data);
        setNextCursor(page.nextCursor);
      })
      .catch((e: unknown) => current && fail(e));
    return () => {
      current = false;
    };
  }, [fetchPage, filters, fail]);

  async function loadMore() {
    if (!nextCursor) return;
    setBusy(true);
    try {
      const page = await fetchPage(filters, nextCursor);
      setEntries((list) => [...(list ?? []), ...page.data]);
      setNextCursor(page.nextCursor);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  const set = (key: keyof Filters) => (value: string) =>
    setFilters((f) => ({ ...f, [key]: value }));
  const filtered = Object.values(filters).some(Boolean);

  return (
    <section className="space-y-5">
      <PageHeader title={t('audit.title')} sub={t('audit.hint')} />

      <Surface className="grid gap-4 p-4 sm:grid-cols-2 sm:p-5 xl:grid-cols-[1fr_1fr_auto_auto_auto] xl:items-end">
        <div className="space-y-1.5">
          <Label htmlFor="audit-action">{t('audit.area')}</Label>
          <NativeSelect
            id="audit-action"
            value={filters.action}
            onChange={(e) => set('action')(e.target.value)}
          >
            <option value="">{t('audit.allAreas')}</option>
            {AREAS.map((area) => (
              <option key={area.prefix} value={area.prefix}>
                {t(area.label)}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="audit-actor">{t('audit.staff')}</Label>
          <NativeSelect
            id="audit-actor"
            value={filters.actorUserId}
            onChange={(e) => set('actorUserId')(e.target.value)}
          >
            <option value="">{t('audit.allStaff')}</option>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="audit-from">{t('audit.from')}</Label>
          <Input
            id="audit-from"
            type="date"
            value={filters.from}
            max={filters.to || undefined}
            onChange={(e) => set('from')(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="audit-to">{t('audit.to')}</Label>
          <Input
            id="audit-to"
            type="date"
            value={filters.to}
            min={filters.from || undefined}
            onChange={(e) => set('to')(e.target.value)}
          />
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={!filtered}
          onClick={() => setFilters(NO_FILTERS)}
        >
          {t('audit.clear')}
        </Button>
      </Surface>

      {error && (
        <p
          role="alert"
          className="rounded-xl bg-danger-soft px-4 py-3 text-sm font-medium text-destructive"
        >
          {error}
        </p>
      )}
      {!entries ? (
        !error && (
          <p aria-live="polite" className="text-sm text-muted-foreground">
            {t('common.loading')}
          </p>
        )
      ) : entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('audit.empty')}</p>
      ) : (
        <Surface className="overflow-x-auto p-2 sm:p-4">
          <table className="w-full min-w-[40rem] text-sm" data-testid="audit-entries">
            <caption className="sr-only">{t('audit.title')}</caption>
            <thead>
              <tr className="border-b border-border">
                <th scope="col" className={TH}>
                  {t('audit.when')}
                </th>
                <th scope="col" className={TH}>
                  {t('audit.who')}
                </th>
                <th scope="col" className={TH}>
                  {t('audit.action')}
                </th>
                <th scope="col" className={TH}>
                  {t('audit.record')}
                </th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className="border-b border-border/60 align-top last:border-0">
                  <td className="tabular whitespace-nowrap px-3 py-2">
                    {formatIstDateTime(e.at, locale)}
                  </td>
                  <td className="px-3 py-2">
                    {e.actorName ?? (e.actorUserId ? t('audit.patientOrOther') : t('audit.system'))}
                  </td>
                  <td className="px-3 py-2">
                    <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{e.action}</code>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {e.entityType ? (
                      <>
                        {e.entityType}{' '}
                        {e.entityId && (
                          <span className="tabular text-xs" title={e.entityId}>
                            {e.entityId.slice(0, 8)}
                          </span>
                        )}
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {nextCursor && (
            <div className="p-2 pt-4">
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => void loadMore()}
              >
                {t('audit.more')}
              </Button>
            </div>
          )}
        </Surface>
      )}
    </section>
  );
}
