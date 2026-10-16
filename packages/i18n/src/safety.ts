import type { MessageKey } from './en';

type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

/** The parts of a safety alert its wording needs (contracts `SafetyAlert`). */
export interface AlertWording {
  ruleId: string;
  params: Record<string, string | number>;
}

/** A safety alert in the clinic's language, from its rule and the names and numbers it carries. */
export function alertText(alert: AlertWording, t: Translate): string {
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
