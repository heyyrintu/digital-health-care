import { describe, expect, it } from 'vitest';
import { pickLocale } from './pick';

describe('pickLocale', () => {
  it('takes the first translated language the device prefers', () => {
    expect(pickLocale(['hi', 'en'])).toBe('hi');
    expect(pickLocale(['ta', 'hi-IN'])).toBe('hi');
    expect(pickLocale(['EN_in'])).toBe('en');
  });

  it('falls back to English', () => {
    expect(pickLocale(['ta', null, undefined])).toBe('en');
    expect(pickLocale([])).toBe('en');
  });
});
