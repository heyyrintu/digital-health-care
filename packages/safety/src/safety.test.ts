import { describe, expect, it } from 'vitest';
import {
  LOCKED_RULE_IDS,
  SAFETY_RULES,
  alertKey,
  getSafetyRule,
  hasUnresolvedBlock,
  isLockedRule,
  type SafetyAlertResult,
} from './index';

describe('catalogue', () => {
  it('lists SR-01 to SR-22 exactly once, in order', () => {
    expect(SAFETY_RULES.map((r) => r.id)).toEqual(
      Array.from({ length: 22 }, (_, i) => `SR-${String(i + 1).padStart(2, '0')}`),
    );
  });

  it('only locks block-level rules that clinics cannot tune', () => {
    for (const id of LOCKED_RULE_IDS) {
      const rule = getSafetyRule(id);
      expect(rule.severity).toBe('block');
      expect(rule.clinicTuning).toBe('no');
    }
    expect(isLockedRule('SR-01')).toBe(true);
    expect(isLockedRule('SR-06')).toBe(false);
  });

  it('allows visibility tuning only on non-block rules', () => {
    for (const rule of SAFETY_RULES.filter((r) => r.clinicTuning === 'visibility_only')) {
      expect(rule.severity).not.toBe('block');
    }
  });
});

describe('hasUnresolvedBlock', () => {
  const block = (overridable: boolean): SafetyAlertResult => ({
    ruleId: 'SR-14',
    severity: 'block',
    itemId: 'item-1',
    message: 'Maximum daily dose exceeded',
    overridable,
  });

  it('is false when only warnings and info remain', () => {
    expect(
      hasUnresolvedBlock([{ ruleId: 'SR-07', severity: 'warn', message: 'x', overridable: false }]),
    ).toBe(false);
  });

  it('blocks until an overridable block is overridden', () => {
    expect(hasUnresolvedBlock([block(true)])).toBe(true);
    expect(hasUnresolvedBlock([block(true)], new Set([alertKey(block(true))]))).toBe(false);
  });

  it('never lets a non-overridable block be cleared by an override', () => {
    expect(hasUnresolvedBlock([block(false)], new Set([alertKey(block(false))]))).toBe(true);
  });
});
