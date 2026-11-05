import { verifyRecordLinkToken } from '@dhc/secure-links';
import type { Job } from 'bullmq';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordNoticeProcessor, sendRecordNotice } from './record-notices';
import { loadConfig } from './config';
const sql = vi.hoisted(() => ({ query: vi.fn(), execute: vi.fn() }));
vi.mock('@dhc/db', () => ({
  withMessaging: async (_db: unknown, fn: (tx: unknown) => unknown) =>
    fn({ $queryRaw: sql.query, $executeRaw: sql.execute }),
}));
const env = {
  WHATSAPP_RECORDS_ENABLED: 'true',
  DATABASE_URL: 'postgresql://synthetic@localhost/test',
  WHATSAPP_ACCESS_TOKEN: 'synthetic-token',
  WHATSAPP_PHONE_NUMBER_ID: '1234',
  WHATSAPP_GRAPH_API_VERSION: 'v23.0',
  WHATSAPP_RECORD_TEMPLATE: 'record_available',
  WHATSAPP_RECORD_TEMPLATE_LANGUAGE: 'en_US',
  WHATSAPP_RECORD_LINK_SECRET: 'synthetic-record-link-secret-at-least-32',
  WEB_BASE_URL: 'https://portal.test',
};
const config = loadConfig(env),
  id = '12345678-1234-4234-8234-123456789abc';
const notice = {
  phone: '+919876543210',
  organisation_slug: 'clinic-a',
  link_expires_at: new Date(Date.now() + 3600000),
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  sql.query.mockReset();
  sql.execute.mockReset();
});
describe('generic record messages', () => {
  it('sends one approved body parameter: a signed navigation link with no clinical content', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ messaging_product: 'whatsapp', messages: [{ id: 'wamid.synthetic' }] }),
      );
    expect(await sendRecordNotice(config, id, notice, fetcher)).toBe('wamid.synthetic');
    const [url, request] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://graph.facebook.com/v23.0/1234/messages');
    expect(request?.redirect).toBe('error');
    const body = JSON.parse(request!.body as string);
    expect(body.template.name).toBe('record_available');
    const params = body.template.components[0].parameters;
    expect(params).toHaveLength(1);
    const link = new URL(params[0].text);
    expect(link.origin).toBe('https://portal.test');
    expect(link.searchParams.get('clinic')).toBe('clinic-a');
    expect(
      verifyRecordLinkToken(link.pathname.split('/').at(-1)!, env.WHATSAPP_RECORD_LINK_SECRET)
        ?.deliveryId,
    ).toBe(id);
    expect(JSON.stringify(body)).not.toMatch(/patientName|prescription|diagnos|sourceId/);
  });
  it.each([400, 429, 500])('never retries HTTP %s and keeps failures generic', async (status) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ sensitive: '9876543210 synthetic-token' }, { status }));
    const error = await sendRecordNotice(config, id, notice, fetcher).catch((e: unknown) => e);
    expect(error).toMatchObject({ result: status < 500 ? 'submission_failed' : 'uncertain' });
    expect(String(error)).not.toMatch(/9876543210|synthetic-token/);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('requires record configuration independently of appointment settings', () => {
    expect(() => loadConfig({ ...env, WHATSAPP_RECORD_LINK_SECRET: undefined })).toThrow();
    expect(loadConfig({}).WHATSAPP_RECORDS_ENABLED).toBe(false);
    expect(() => loadConfig({ ...env, WEB_BASE_URL: 'http://portal.test' })).toThrow();
  });
  it('only submits after database authorization, persists uncertain outcome, and cannot resend', async () => {
    sql.query.mockResolvedValueOnce([notice]).mockResolvedValueOnce([]);
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('sensitive network payload'));
    vi.stubGlobal('fetch', fetcher);
    const process = recordNoticeProcessor({} as never, config),
      job = { name: 'record-notice', data: { deliveryId: id } } as Job;
    await process(job);
    await process(job);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(sql.execute).toHaveBeenCalledOnce();
    expect(sql.execute.mock.calls[0]).toContain('uncertain');
    await expect(
      process({ name: 'record-notice', data: { deliveryId: id, phone: notice.phone } } as Job),
    ).rejects.toThrow();
  });
});
