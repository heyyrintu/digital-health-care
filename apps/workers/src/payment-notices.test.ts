import { afterEach, describe, it, expect, vi } from 'vitest';
import { sendPaymentNotice, NoticeSendFailure } from './payment-notices';
import { loadConfig } from './config';
import { verifyFinanceLinkToken, verifyRecordLinkToken } from '@dhc/secure-links';
const id = '11111111-1111-4111-8111-111111111111',
  secret = 'synthetic-finance-secret-32-characters';
const env = {
  WHATSAPP_PAYMENTS_ENABLED: 'true',
  DATABASE_URL: 'postgresql://synthetic:synthetic@localhost/test',
  WEB_BASE_URL: 'https://portal.test',
  WHATSAPP_ACCESS_TOKEN: 'synthetic-access-token',
  WHATSAPP_PHONE_NUMBER_ID: '1234',
  WHATSAPP_GRAPH_API_VERSION: 'v23.0',
  WHATSAPP_PAYMENT_LINK_SECRET: secret,
  WHATSAPP_PAYMENT_TEMPLATE: 'payment_update',
  WHATSAPP_PAYMENT_TEMPLATE_LANGUAGE: 'en_US',
};
const config = loadConfig(env);
afterEach(() => vi.restoreAllMocks());
describe('financial availability notice transport', () => {
  it('sends a generic approved template containing only an authenticated, expiring navigation link', async () => {
    const expires = new Date(Date.now() + 3600000),
      fetcher = vi.fn<typeof fetch>(async () =>
        Response.json({ messaging_product: 'whatsapp', messages: [{ id: 'wamid.synthetic' }] }),
      );
    expect(
      await sendPaymentNotice(
        config,
        id,
        { phone: '+919000000001', organisation_slug: 'clinic-a', link_expires_at: expires },
        fetcher,
      ),
    ).toBe('wamid.synthetic');
    const [url, request] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://graph.facebook.com/v23.0/1234/messages');
    expect(request?.redirect).toBe('error');
    const body = JSON.parse(request!.body as string);
    expect(body.biz_opaque_callback_data).toBe(id);
    expect(body.template.name).toBe('payment_update');
    const params = body.template.components[0].parameters;
    expect(params).toHaveLength(1);
    const link = new URL(params[0].text);
    expect(link.pathname).toMatch(/^\/app\/payments\/notice\//);
    expect(link.searchParams.get('clinic')).toBe('clinic-a');
    const token = link.pathname.split('/').at(-1)!;
    expect(verifyFinanceLinkToken(token, secret)?.deliveryId).toBe(id);
    expect(verifyRecordLinkToken(token, secret)).toBeNull();
  });
  it('keeps uncertain sends non-retryable at the transport boundary and exposes no provider body', async () => {
    const notice = {
      phone: '+919000000001',
      organisation_slug: 'clinic-a',
      link_expires_at: new Date(Date.now() + 3600000),
    };
    await expect(
      sendPaymentNotice(
        config,
        id,
        notice,
        async () => new Response('private response', { status: 500 }),
      ),
    ).rejects.toMatchObject({
      result: 'uncertain',
      message: 'WhatsApp payment submission could not be confirmed',
    });
    await expect(
      sendPaymentNotice(
        config,
        id,
        notice,
        async () => new Response('private response', { status: 400 }),
      ),
    ).rejects.toBeInstanceOf(NoticeSendFailure);
  });
  it('stays off by default and requires the shared secret, template and HTTPS when enabled', () => {
    expect(loadConfig({}).WHATSAPP_PAYMENTS_ENABLED).toBe(false);
    expect(() => loadConfig({ WHATSAPP_PAYMENTS_ENABLED: 'true' })).toThrow();
    expect(() =>
      loadConfig({
        ...env,
        WHATSAPP_PAYMENTS_ENABLED: 'true',
        WEB_BASE_URL: 'http://portal.test',
      }),
    ).toThrow();
  });
});
