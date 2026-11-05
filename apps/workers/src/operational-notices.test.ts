import { afterEach, expect, it, vi } from 'vitest';
import { loadConfig } from './config';
import { sendAppointmentNotice, NoticeSendFailure } from './appointment-notices';
const env = {
  WHATSAPP_OPERATIONS_ENABLED: 'true',
  DATABASE_URL: 'postgresql://synthetic@localhost/test',
  WHATSAPP_ACCESS_TOKEN: 'synthetic',
  WHATSAPP_PHONE_NUMBER_ID: '1234',
  WHATSAPP_GRAPH_API_VERSION: 'v25.0',
  WHATSAPP_OPERATION_TEMPLATE: 'appointment_update',
  WHATSAPP_OPERATION_TEMPLATE_LANGUAGE: 'en',
  WEB_BASE_URL: 'https://portal.test',
};
afterEach(() => vi.restoreAllMocks());
it('requires the operational template and HTTPS portal settings only when this dispatcher is enabled', () => {
  expect(loadConfig(env).WHATSAPP_OPERATIONS_ENABLED).toBe(true);
  expect(() => loadConfig({ ...env, WHATSAPP_OPERATION_TEMPLATE: undefined })).toThrow();
  expect(() => loadConfig({ ...env, WEB_BASE_URL: 'http://portal.test' })).toThrow();
  expect(loadConfig({}).WHATSAPP_OPERATIONS_ENABLED).toBe(false);
});
it('sends a generic clinic/portal update with no patient, reason, times, delay or financial data', async () => {
  const f = vi.fn<typeof fetch>(async () =>
      Response.json({ messaging_product: 'whatsapp', messages: [{ id: 'wamid.synthetic' }] }),
    ),
    id = '12345678-1234-4234-8234-123456789abc';
  await sendAppointmentNotice(
    loadConfig(env),
    id,
    {
      phone: '+919876543210',
      kind: 'appointment_update',
      clinic_name: 'Synthetic Clinic',
      organisation_slug: 'clinic-a',
      start_at: new Date(),
    },
    f,
  );
  const request = f.mock.calls[0]![1]!,
    body = JSON.parse(request.body as string);
  expect(body.template.name).toBe('appointment_update');
  expect(body.biz_opaque_callback_data).toBe(id);
  expect(body.template.components[0].parameters.map((p: { text: string }) => p.text)).toEqual([
    'Synthetic Clinic',
    'https://portal.test/app/login?clinic=clinic-a',
  ]);
  expect(request.redirect).toBe('error');
});
it('preserves uncertain delivery semantics after a provider timeout', async () => {
  const f = vi.fn<typeof fetch>(async () => {
    throw new Error('Timed out');
  });
  await expect(
    sendAppointmentNotice(
      loadConfig(env),
      'id',
      {
        phone: '+919876543210',
        kind: 'appointment_update',
        clinic_name: 'Clinic',
        organisation_slug: 'clinic',
        start_at: new Date(),
      },
      f,
    ),
  ).rejects.toEqual(new NoticeSendFailure('uncertain'));
  expect(f).toHaveBeenCalledTimes(1);
});
