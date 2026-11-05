import { expect, it } from 'vitest';
import { loadConfig } from '../../config';
const base = {
  NODE_ENV: 'test',
  WHATSAPP_INBOX_ENABLED: 'true',
  WHATSAPP_WEBHOOK_ENABLED: 'true',
  WHATSAPP_ACCESS_TOKEN: 'synthetic-token',
  WHATSAPP_GRAPH_API_VERSION: 'v25.0',
  WHATSAPP_PHONE_NUMBER_ID: '111',
  WHATSAPP_BUSINESS_ACCOUNT_ID: '222',
  WHATSAPP_APP_SECRET: 'synthetic-app-secret',
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: 'synthetic-verification-token-32-characters',
};
const channel = {
  organisationId: '00000000-0000-4000-8000-000000000001',
  senderId: '9999',
  businessId: '222',
};
it('allows dedicated clinic inbox numbers while refusing the shared OTP/notice sender', () => {
  expect(
    loadConfig({ ...base, WHATSAPP_INBOX_CHANNELS_JSON: JSON.stringify([channel]) })
      .WHATSAPP_INBOX_ENABLED,
  ).toBe(true);
  expect(() =>
    loadConfig({
      ...base,
      WHATSAPP_INBOX_CHANNELS_JSON: JSON.stringify([{ ...channel, senderId: '111' }]),
    }),
  ).toThrow('shared OTP');
});
it('requires signed webhook setup and valid distinct bindings when enabling inbox intake', () => {
  expect(() =>
    loadConfig({
      ...base,
      WHATSAPP_WEBHOOK_ENABLED: 'false',
      WHATSAPP_INBOX_CHANNELS_JSON: JSON.stringify([channel]),
    }),
  ).toThrow();
  expect(() => loadConfig({ ...base, WHATSAPP_INBOX_CHANNELS_JSON: '[]' })).toThrow();
  expect(loadConfig({ NODE_ENV: 'test' }).WHATSAPP_INBOX_ENABLED).toBe(false);
});
