'use client';

import { ApiError } from '@dhc/api-client';
import type { PlatformHealth } from '@dhc/contracts';
import type { MessageKey } from '@dhc/i18n';
import { Button, PageHeader, Surface } from '@dhc/ui-web';
import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  countOrDash,
  formatCheckedAt,
  healthErrorKey,
  healthStatusKey,
  healthTone,
  queueLabelKey,
  queuesNoteKey,
  queuesWithFailures,
  uptimeMessage,
  type HealthStatus,
} from '../../../lib/platform';
import { usePlatformSession } from '../session-provider';
import { ErrorNotice, PlatformShell } from '../shell';

const TH = 'py-2 pr-3 text-left text-xs font-semibold text-muted-foreground';
const NUM = 'py-2 pr-3 text-right tabular';

const TONE_CLASSES = {
  ok: 'bg-success-soft text-success',
  danger: 'bg-danger-soft text-destructive',
  neutral: 'border border-border bg-card text-muted-foreground',
} as const;

/**
 * System health (PRD §9.3): the API, the database and the background queues, status and
 * counts only. Checked when the page opens and on Refresh, never on a timer, since each
 * check is audited.
 */
export default function HealthPage() {
  return <PlatformShell>{() => <HealthScreen />}</PlatformShell>;
}

function HealthScreen() {
  const { api, locale, signOut, t } = usePlatformSession();
  const [health, setHealth] = useState<PlatformHealth | null>(null);
  const [checking, setChecking] = useState(false);
  // Kept as keys and translated when shown, so switching language does not check again.
  const [error, setError] = useState<{ key: MessageKey } | { text: string } | null>(null);

  /** The latest check asked for: answers to earlier ones are dropped. */
  const latest = useRef(0);

  const check = useCallback(async () => {
    const request = ++latest.current;
    setChecking(true);
    setError(null);
    try {
      const answer = await api.platform.health();
      if (request === latest.current) setHealth(answer);
    } catch (e) {
      if (request !== latest.current) return;
      if (e instanceof ApiError && e.status === 401) return void signOut('expired');
      // An earlier report would now be out of date: show only the error.
      setHealth(null);
      const key = healthErrorKey(e);
      setError(key ? { key } : { text: (e as Error).message });
    } finally {
      if (request === latest.current) setChecking(false);
    }
  }, [api, signOut]);

  useEffect(() => {
    void check();
  }, [check]);

  const count = (n: number | null) => countOrDash(n, locale);
  const failing = health ? queuesWithFailures(health) : [];
  const uptime = health ? uptimeMessage(health.api.uptimeSeconds) : null;

  return (
    <section className="space-y-5">
      <PageHeader
        title={t('platform.health.title')}
        sub={t('platform.health.sub')}
        actions={
          <Button onClick={() => void check()} disabled={checking} aria-busy={checking}>
            <RefreshCw className={checking ? 'animate-spin' : undefined} aria-hidden />
            {t('platform.health.refresh')}
          </Button>
        }
      />

      <ErrorNotice message={error && ('key' in error ? t(error.key) : error.text)} />

      {!health ? (
        !error && (
          <p aria-live="polite" className="text-sm text-muted-foreground">
            {t('common.loading')}
          </p>
        )
      ) : (
        <>
          <p className="text-sm text-muted-foreground" aria-live="polite" data-testid="checked-at">
            {t('platform.health.checkedAt', { time: formatCheckedAt(health.checkedAt, locale) })}
          </p>

          <div className="grid gap-4 md:grid-cols-3">
            <StatusCard title={t('platform.health.api')} status="ok" testId="health-api">
              <p>{t('platform.health.version', { version: health.api.version })}</p>
              {uptime && <p>{t(uptime.key, uptime.params)}</p>}
            </StatusCard>
            <StatusCard
              title={t('platform.health.database')}
              status={health.database.status}
              testId="health-database"
            >
              {health.database.status === 'ok' ? (
                <>
                  <p>{t('platform.health.latency', { ms: count(health.database.latencyMs) })}</p>
                  <p className="break-all" data-testid="health-migration">
                    {health.database.latestMigration
                      ? t('platform.health.migration', { name: health.database.latestMigration })
                      : t('platform.health.noMigration')}
                  </p>
                </>
              ) : (
                <p>{t('platform.health.databaseDown')}</p>
              )}
            </StatusCard>
            <StatusCard
              title={t('platform.health.queues')}
              status={health.queues.status}
              testId="health-queues"
            >
              <p>{t(queuesNoteKey(health.queues.status))}</p>
            </StatusCard>
          </div>

          {failing.length > 0 && (
            <p
              role="alert"
              data-testid="health-failed"
              className="rounded-xl bg-danger-soft px-4 py-3 text-sm font-medium text-destructive"
            >
              {t('platform.health.failedNotice', {
                queues: failing.map((name) => t(queueLabelKey(name))).join(', '),
              })}
            </p>
          )}

          {health.queues.items.length > 0 && (
            <Surface className="min-w-0 p-4 sm:p-6">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[36rem] text-sm" data-testid="health-queue-counts">
                  <caption className="sr-only">{t('platform.health.queues')}</caption>
                  <thead>
                    <tr className="border-b border-border">
                      <th scope="col" className={TH}>
                        {t('platform.health.queue')}
                      </th>
                      <th scope="col" className={`${TH} text-right`}>
                        {t('platform.health.waiting')}
                      </th>
                      <th scope="col" className={`${TH} text-right`}>
                        {t('platform.health.active')}
                      </th>
                      <th scope="col" className={`${TH} text-right`}>
                        {t('platform.health.delayed')}
                      </th>
                      <th scope="col" className={`${TH} text-right`}>
                        {t('platform.health.failed')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {health.queues.items.map((q) => (
                      <tr
                        key={q.name}
                        data-testid={`queue-${q.name}`}
                        className="border-b border-border/60"
                      >
                        <th scope="row" className="py-2 pr-3 text-left font-normal">
                          <strong className="font-semibold">{t(queueLabelKey(q.name))}</strong>
                          <span className="block font-mono text-xs text-muted-foreground">
                            {q.name}
                          </span>
                        </th>
                        <td className={NUM}>{count(q.waiting)}</td>
                        <td className={NUM}>{count(q.active)}</td>
                        <td className={NUM}>{count(q.delayed)}</td>
                        <td
                          className={q.failed > 0 ? `${NUM} font-semibold text-destructive` : NUM}
                          data-testid="queue-failed"
                        >
                          {q.failed > 0 ? (
                            <span className="rounded-md bg-danger-soft px-2 py-0.5">
                              {count(q.failed)}
                            </span>
                          ) : (
                            count(q.failed)
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                {t('platform.health.countsOnly')}
              </p>
            </Surface>
          )}
        </>
      )}
    </section>
  );
}

function StatusCard({
  title,
  status,
  testId,
  children,
}: {
  title: string;
  status: HealthStatus;
  testId: string;
  children: ReactNode;
}) {
  const { t } = usePlatformSession();
  return (
    <Surface className="space-y-2 p-4 sm:p-5" data-testid={testId}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-display text-base font-bold">{title}</h2>
        <span
          className={`inline-flex items-center rounded-md px-2.5 py-0.5 text-xs font-semibold ${TONE_CLASSES[healthTone(status)]}`}
          data-testid="status"
        >
          {t(healthStatusKey(status))}
        </span>
      </div>
      <div className="space-y-1 text-sm text-muted-foreground">{children}</div>
    </Surface>
  );
}
