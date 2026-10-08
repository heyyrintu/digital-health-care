'use client';

import type { SafetyAlert, SafetySummary } from '@dhc/contracts';
import type { MessageKey } from '@dhc/i18n';
import { useState } from 'react';
import { useSession } from '../session-provider';

type Translate = ReturnType<typeof useSession>['t'];

/** The alert in the clinic's language, from its rule and the names and numbers it carries. */
export function alertText(alert: SafetyAlert, t: Translate): string {
  const p = alert.params;
  const variant =
    alert.ruleId === 'SR-11' ? `.${p.status}` : alert.ruleId === 'SR-13' ? `.${p.direction}` : '';
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
    <div className="safety-banner" data-testid="safety-banner" aria-live="polite">
      {checking ? (
        <p className="hint">{t('safety.checking')}</p>
      ) : safety.openBlocks === 0 && safety.openWarnings === 0 ? (
        <p className="hint">{safety.alerts.length === 0 ? t('safety.clear') : ''}</p>
      ) : (
        <>
          {safety.openBlocks > 0 && (
            <p className="safety-count block">
              {t('safety.openBlocks', { count: safety.openBlocks })}
            </p>
          )}
          {safety.openWarnings > 0 && (
            <p className="safety-count warn">
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
    <ul className="safety-alerts" data-testid="safety-alerts">
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
    <li className={`safety-alert ${alert.severity}`} data-rule={alert.ruleId}>
      <p>
        <strong>{t(`safety.severity.${alert.severity}`)}:</strong> {alertText(alert, t)}
        {alert.unverified && <span className="pill">{t('safety.unverified')}</span>}
      </p>
      {alert.params.note && alert.ruleId !== 'SR-09' && (
        <p className="hint">{String(alert.params.note)}</p>
      )}
      {alert.action === 'acknowledged' || alert.action === 'overridden' ? (
        <p className="hint">
          {t(`safety.${alert.action}`)}
          {alert.reason ? `: ${alert.reason}` : ''}
        </p>
      ) : alert.severity === 'block' && !alert.overridable ? (
        <p className="hint">{t('safety.mustChange')}</p>
      ) : null}
      {action && canAct && (
        <div className="inline-form">
          {needsReason && (
            <div>
              <label htmlFor={reasonId}>{t('safety.reason')}</label>
              <input
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
                <p role="alert" className="hint">
                  {t('safety.reasonNeeded')}
                </p>
              )}
            </div>
          )}
          <button type="button" className="secondary" disabled={busy} onClick={() => void submit()}>
            {t(action === 'acknowledge' ? 'safety.acknowledge' : 'safety.override')}
          </button>
        </div>
      )}
    </li>
  );
}
