import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config';
import { parseMfaPhones } from './mfa-otp';
describe('second-factor configuration', () => {
  it('defaults both audiences to authenticator and permits explicit password-only mode', () => {
    expect(loadConfig({}).STAFF_MFA_MODE).toBe('totp');
    expect(loadConfig({}).PLATFORM_MFA_MODE).toBe('totp');
    const config = loadConfig({ STAFF_MFA_MODE: 'disabled', PLATFORM_MFA_MODE: 'disabled' });
    expect(config.STAFF_MFA_MODE).toBe('disabled');
    expect(config.PLATFORM_MFA_MODE).toBe('disabled');
    expect(() => loadConfig({ STAFF_MFA_MODE: 'false' })).toThrow();
  });
  it('requires real WhatsApp delivery and configured operator recipients', () => {
    expect(() => loadConfig({ STAFF_MFA_MODE: 'whatsapp' })).toThrow();
    expect(() => loadConfig({ PLATFORM_MFA_MODE: 'whatsapp', OTP_DELIVERY: 'whatsapp' })).toThrow();
    expect(() => loadConfig({ STAFF_MFA_PHONES_JSON: 'not-json' })).toThrow();
    const sender = {
      OTP_DELIVERY: 'whatsapp',
      WHATSAPP_ACCESS_TOKEN: 'synthetic-token',
      WHATSAPP_PHONE_NUMBER_ID: '1234',
      WHATSAPP_GRAPH_API_VERSION: 'v23.0',
      WHATSAPP_OTP_TEMPLATE_NAME: 'staff_code',
      WHATSAPP_OTP_TEMPLATE_LANGUAGE: 'en_US',
    };
    expect(() =>
      loadConfig({ ...sender, PLATFORM_MFA_MODE: 'whatsapp', PLATFORM_MFA_PHONES_JSON: '{}' }),
    ).toThrow();
    expect(
      loadConfig({
        ...sender,
        STAFF_MFA_MODE: 'whatsapp',
        PLATFORM_MFA_MODE: 'whatsapp',
        PLATFORM_MFA_PHONES_JSON: '{"operator@example.test":"+919876543210"}',
      }).PLATFORM_MFA_MODE,
    ).toBe('whatsapp');
  });
  it('normalises mappings and rejects non-mobile, malformed and duplicate email keys', () => {
    expect(parseMfaPhones('{"Ops@Example.test":"98765 43210"}')).toEqual({
      'ops@example.test': '+919876543210',
    });
    expect(() => parseMfaPhones('{"ops@example.test":"123"}')).toThrow();
    expect(() => parseMfaPhones('{"__proto__":"9876543210"}')).toThrow();
    expect(() =>
      parseMfaPhones('{"Ops@example.test":"9876543210","ops@example.test":"9876543210"}'),
    ).toThrow();
  });
});
