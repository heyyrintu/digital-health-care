import { describe, expect, it } from 'vitest';
import { MIN_TOUCH_TARGET, toCssVariables } from './index';

describe('toCssVariables', () => {
  it('flattens colours and adds px units to sizes', () => {
    const vars = toCssVariables();
    expect(vars['--color-brand-500']).toMatch(/^#[0-9a-f]{6}$/);
    expect(vars['--color-severity-block']).toBeDefined();
    expect(vars['--space-4']).toBe('16px');
    expect(vars['--radius-full']).toBe('9999px');
  });

  it('keeps the accessible touch target', () => {
    expect(MIN_TOUCH_TARGET).toBeGreaterThanOrEqual(44);
  });
});
