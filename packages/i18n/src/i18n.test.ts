import { describe, expect, it } from 'vitest';
import { LOCALES, messages, placeholdersOf, t, type MessageKey } from './index';

describe('messages', () => {
  const keys = Object.keys(messages.en) as MessageKey[];

  it.each(LOCALES)('%s has every key with the same placeholders as English', (locale) => {
    expect(Object.keys(messages[locale]).sort()).toEqual([...keys].sort());
    for (const key of keys) {
      expect(placeholdersOf(messages[locale][key]), key).toEqual(placeholdersOf(messages.en[key]));
      expect(messages[locale][key].trim(), key).not.toBe('');
    }
  });
});

describe('t', () => {
  it('fills placeholders', () => {
    expect(t('en', 'queue.token', { token: 14 })).toBe('Token 14');
    expect(t('hi', 'queue.token', { token: 14 })).toBe('टोकन 14');
  });

  it('leaves missing placeholders visible', () => {
    expect(t('en', 'portal.welcome')).toBe('Welcome, {name}');
  });
});
