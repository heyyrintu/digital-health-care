import type { Job } from 'bullmq';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  appointmentNoticeProcessor,
  sendAppointmentNotice,
  type AppointmentNotice,
} from './appointment-notices';
import { loadConfig } from './config';

const sql = vi.hoisted(() => ({ query: vi.fn(), execute: vi.fn() }));
vi.mock('@dhc/db', () => ({
  withMessaging: async (_db: unknown, fn: (tx: unknown) => unknown) =>
    fn({ $queryRaw: sql.query, $executeRaw: sql.execute }),
}));
const env = {
  WHATSAPP_APPOINTMENTS_ENABLED: 'true',
  DATABASE_URL: 'postgresql://synthetic@localhost/test',
  WHATSAPP_ACCESS_TOKEN: 'synthetic-token',
  WHATSAPP_PHONE_NUMBER_ID: '1234',
  WHATSAPP_GRAPH_API_VERSION: 'v23.0',
  WHATSAPP_APPOINTMENT_CONFIRMATION_TEMPLATE: 'appointment_confirmed',
  WHATSAPP_APPOINTMENT_REMINDER_TEMPLATE: 'appointment_reminder',
  WHATSAPP_APPOINTMENT_TEMPLATE_LANGUAGE: 'en_US',
  WEB_BASE_URL: 'https://portal.test',
};
const config = loadConfig(env);
const id = '12345678-1234-4234-8234-123456789abc';
const notice: AppointmentNotice = {
  phone: '+919876543210',
  kind: 'appointment_confirmation',
  clinic_name: 'Synthetic Clinic',
  organisation_slug: 'clinic-a',
  start_at: new Date('2026-11-06T04:30:00Z'),
};
const accepted = () =>
  Response.json({ messaging_product: 'whatsapp', messages: [{ id: 'wamid.synthetic' }] });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  sql.query.mockReset();
  sql.execute.mockReset();
});

describe('appointment template submission', () => {
  it.each(['appointment_confirmation', 'appointment_reminder'] as const)(
    'sends the approved %s template with only clinic, IST time and authenticated portal link',
    async (kind) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(accepted());
      expect(await sendAppointmentNotice(config, id, { ...notice, kind }, fetcher)).toBe(
        'wamid.synthetic',
      );
      const [url, request] = fetcher.mock.calls[0]!;
      expect(url).toBe('https://graph.facebook.com/v23.0/1234/messages');
      expect(request?.redirect).toBe('error');
      const body = JSON.parse(request!.body as string);
      expect(body.to).toBe('919876543210');
      expect(body.biz_opaque_callback_data).toBe(id);
      expect(body.template.name).toBe(
        kind === 'appointment_confirmation' ? 'appointment_confirmed' : 'appointment_reminder',
      );
      const params = body.template.components[0].parameters.map((p: { text: string }) => p.text);
      expect(params[0]).toBe('Synthetic Clinic');
      expect(params[1]).toContain('Nov');
      expect(params[2]).toMatch(/10:00/);
      expect(params[3]).toBe('https://portal.test/app/login?clinic=clinic-a');
      expect(JSON.stringify(body)).not.toContain('patientId');
    },
  );
  it.each([400, 401, 429, 500, 503])(
    'does not retry HTTP %s and sanitizes failures',
    async (status) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ sensitive: 'synthetic-token 9876543210' }, { status }));
      const e = await sendAppointmentNotice(config, id, notice, fetcher).catch((e: unknown) => e);
      expect(e).toMatchObject({ result: status < 500 ? 'submission_failed' : 'uncertain' });
      expect(String(e)).not.toMatch(/synthetic-token|9876543210/);
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );
  it('treats network failures and malformed acceptance as uncertain', async () => {
    for (const fetcher of [
      vi.fn<typeof fetch>().mockRejectedValue(new Error('sensitive')),
      vi.fn<typeof fetch>().mockResolvedValue(Response.json({})),
    ]) {
      await expect(sendAppointmentNotice(config, id, notice, fetcher)).rejects.toMatchObject({
        result: 'uncertain',
      });
    }
  });
});

describe('outgoing worker boundary', () => {
  it('sends only after the database authorizes a due notice and never resends a claimed notice', async () => {
    sql.query.mockResolvedValueOnce([notice]).mockResolvedValueOnce([]);
    sql.execute.mockResolvedValue(1);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(accepted());
    vi.stubGlobal('fetch', fetcher);
    const run = appointmentNoticeProcessor(
      {} as Parameters<typeof appointmentNoticeProcessor>[0],
      config,
    );
    const job = { name: 'appointment-notice', data: { deliveryId: id } } as Job;
    await run(job);
    await run(job);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(sql.execute).toHaveBeenCalledOnce();
    expect(JSON.stringify(sql.execute.mock.calls)).toContain('accepted');
    await expect(run({ name: 'other', data: { deliveryId: id } } as Job)).rejects.toThrow();
    await expect(
      run({ name: 'appointment-notice', data: { deliveryId: id, phone: 'unexpected' } } as Job),
    ).rejects.toThrow();
  });
  it('persists uncertainty after a timeout instead of throwing a retriable send error', async () => {
    sql.query.mockResolvedValue([notice]);
    sql.execute.mockResolvedValue(1);
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockRejectedValue(new Error('sensitive network failure')),
    );
    await appointmentNoticeProcessor(
      {} as Parameters<typeof appointmentNoticeProcessor>[0],
      config,
    )({ name: 'appointment-notice', data: { deliveryId: id } } as Job);
    expect(JSON.stringify(sql.execute.mock.calls)).toContain('uncertain');
    expect(JSON.stringify(sql.execute.mock.calls)).not.toContain('sensitive');
  });
  it('requires complete settings only when appointment sending is enabled', () => {
    expect(loadConfig({}).WHATSAPP_APPOINTMENTS_ENABLED).toBe(false);
    expect(() => loadConfig({ WHATSAPP_APPOINTMENTS_ENABLED: 'true' })).toThrow();
    expect(() => loadConfig({ ...env, WEB_BASE_URL: 'http://localhost:3000' })).toThrow(/HTTPS/);
    expect(() => loadConfig({ ...env, WHATSAPP_ACCESS_TOKEN: 'bad\nheader' })).toThrow();
  });
});
