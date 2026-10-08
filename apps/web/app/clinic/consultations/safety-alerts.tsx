'use client';

import type { SafetyAlert, SafetySummary } from '@dhc/contracts';
import type { MessageKey } from '@dhc/i18n';
import { Button, Chip, cn, Input, Label } from '@dhc/ui-web';
import { useState } from 'react';
import { useSession } from '../session-provider';

type Translate = ReturnType<typeof useSession>['t'];

/** The alert in the clinic's language, from its rule and the names and numbers it carries. */
export function alertText(alert: SafetyAlert, t: Translate): string {
  const p = alert.params;
  // SR-11 while breastfeeding words a contraindication more strongly than a caution.
  const variant =
    alert.ruleId === 'SR-11'
      ? p.status === 'breastfeeding' && p.risk === 'contraindicated'
        ? '.breastfeedingAvoid'
        : `.${p.status}`
      : alert.ruleId === 'SR-13'
        ? `.${p.direction}`
        : '';
  const params =
    alert.ruleId === 'SR-20'
      ? {
          ...p,
          fields: String(p.fields)
            .split(',')
            .map((f) => t(`safety.field.${f}` as MessageKey))
            .join(', '),
        }
      : p;
  return t(`safety.${alert.ruleId}${variant}` as MessageKey, params);
}

export type SafetyAct = (
  key: string,
  action: 'acknowledge' | 'override',
  reason: string | null,
) => Promise<boolean>;

/**
 * The top of the prescription card: how many blocks and warnings are open, or that the
 * check is waiting for the latest changes to save.
 */
export function SafetyBanner({
  safety,
  checking,
}: {
  safety: SafetySummary | null;
  checking: boolean;
}) {
  const { t } = useSession();
  if (!safety) return null;
  return (
    <div className="space-y-1" data-testid="safety-banner" aria-live="polite">
      {checking ? (
        <p className={hint}>{t('safety.checking')}</p>
      ) : safety.openBlocks === 0 && safety.openWarnings === 0 ? (
        safety.alerts.length === 0 && <p className={hint}>{t('safety.clear')}</p>
      ) : (
        <>
          {safety.openBlocks > 0 && (
            <p className={cn(count, tone.block)}>
              {t('safety.openBlocks', { count: safety.openBlocks })}
            </p>
          )}
          {safety.openWarnings > 0 && (
            <p className={cn(count, tone.warn)}>
              {t('safety.openWarnings', { count: safety.openWarnings })}
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** One line's alerts, each with what the doctor can do about it (PRD §6.5). */
export function LineAlerts({
  alerts,
  canAct,
  onAct,
}: {
  alerts: SafetyAlert[];
  canAct: boolean;
  onAct: SafetyAct;
}) {
  if (alerts.length === 0) return null;
  return (
    <ul className="m-0 list-none space-y-2 p-0" data-testid="safety-alerts">
      {alerts.map((a) => (
        <AlertRow key={a.key} alert={a} canAct={canAct} onAct={onAct} />
      ))}
    </ul>
  );
}

function AlertRow({
  alert,
  canAct,
  onAct,
}: {
  alert: SafetyAlert;
  canAct: boolean;
  onAct: SafetyAct;
}) {
  const { t } = useSession();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [missing, setMissing] = useState(false);

  const action =
    alert.severity === 'warn' && alert.action !== 'acknowledged'
      ? 'acknowledge'
      : alert.severity === 'block' && alert.overridable && alert.action !== 'overridden'
        ? 'override'
        : null;
  const needsReason = action === 'override' || (action === 'acknowledge' && alert.reasonRequired);
  const reasonId = `reason-${alert.key}`;

  async function submit() {
    if (!action) return;
    if (needsReason && !reason.trim()) return setMissing(true);
    setBusy(true);
    const ok = await onAct(alert.key, action, needsReason ? reason.trim() : null);
    setBusy(false);
    if (ok) setReason('');
  }

  return (
    <li
      className={cn(
        'space-y-1.5 rounded-xl border-l-4 px-3.5 py-2.5 text-sm',
        tone[alert.severity],
      )}
      data-rule={alert.ruleId}
    >
      <p className="m-0">
        <strong>{t(`safety.severity.${alert.severity}`)}:</strong> {alertText(alert, t)}
        {alert.unverified && (
          <Chip className="ml-2 bg-card text-foreground">{t('safety.unverified')}</Chip>
        )}
      </p>
      {alert.params.note && alert.ruleId !== 'SR-09' && (
        // Notes come from the reference drug data, which is in English.
        <p className={detail} lang="en">
          {String(alert.params.note)}
        </p>
      )}
      {alert.action === 'acknowledged' || alert.action === 'overridden' ? (
        <p className={detail}>
          {t(`safety.${alert.action}`)}
          {alert.reason ? `: ${alert.reason}` : ''}
        </p>
      ) : alert.severity === 'block' && !alert.overridable ? (
        <p className={detail}>{t('safety.mustChange')}</p>
      ) : null}
      {action && canAct && (
        <div className="flex flex-wrap items-end gap-2">
          {needsReason && (
            <div className="min-w-0 flex-1 space-y-1.5 sm:max-w-sm">
              <Label htmlFor={reasonId} className="block text-sm font-semibold">
                {t('safety.reason')}
              </Label>
              <Input
                id={reasonId}
                value={reason}
                maxLength={300}
                aria-invalid={missing && !reason.trim()}
                onChange={(e) => {
                  setReason(e.target.value);
                  setMissing(false);
                }}
              />
              {missing && !reason.trim() && (
                <p role="alert" className={cn(detail, 'font-semibold')}>
                  {t('safety.reasonNeeded')}
                </p>
              )}
            </div>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void submit()}
          >
            {t(action === 'acknowledge' ? 'safety.acknowledge' : 'safety.override')}
          </Button>
        </div>
      )}
    </li>
  );
}

const hint = 'm-0 text-sm text-muted-foreground';
/** Detail inside an alert keeps the alert's colour, whose contrast the tokens are tested for. */
const detail = 'm-0 text-sm';
const count = 'm-0 rounded-xl border-l-4 px-3.5 py-2 text-sm font-semibold';
/** Red for a block, amber for a warning, blue for information; the text stays readable on each. */
const tone = {
  block: 'border-destructive bg-danger-soft text-destructive',
  warn: 'border-warning bg-warning-soft text-warning-foreground',
  info: 'border-info bg-info-soft text-info',
} as const;
