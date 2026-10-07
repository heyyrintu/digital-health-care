import type { SafetyRuleId, Severity } from './catalogue';

/** What the doctor did with an alert; stored in SafetyAlert and the audit log. */
export type AlertAction = 'accepted' | 'changed' | 'overridden';

/** One alert raised against a prescription line, as returned by the server check. */
export interface SafetyAlertResult {
  ruleId: SafetyRuleId;
  severity: Severity;
  /** Prescription item the alert is about; absent for whole-prescription alerts. */
  itemId?: string;
  message: string;
  /** Set by the licensed drug database for block-level alerts it allows overriding. */
  overridable: boolean;
}

/** The server result is final; clients only preview (catalogue "Behaviour rules"). */
export function hasUnresolvedBlock(
  alerts: readonly SafetyAlertResult[],
  overriddenAlertKeys: ReadonlySet<string> = new Set(),
): boolean {
  return alerts.some(
    (a) => a.severity === 'block' && !(a.overridable && overriddenAlertKeys.has(alertKey(a))),
  );
}

/** Stable key for an alert on a given line, used to match overrides to alerts. */
export function alertKey(alert: Pick<SafetyAlertResult, 'ruleId' | 'itemId'>): string {
  return `${alert.ruleId}:${alert.itemId ?? '*'}`;
}
