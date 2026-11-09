import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config';
import { createOtpSender, MetaWhatsAppOtpSender, OtpDeliveryError } from './otp-sender';

const settings = {
  accessToken: 'synthetic-meta-token',
  phoneNumberId: '123456789',
  version: 'v23.0',
  templateName: 'patient_sign_in',
  language: 'en_US',
};
const env = {
  OTP_DELIVERY: 'whatsapp',
  WHATSAPP_ACCESS_TOKEN: settings.accessToken,
  WHATSAPP_PHONE_NUMBER_ID: settings.phoneNumberId,
  WHATSAPP_GRAPH_API_VERSION: settings.version,
  WHATSAPP_OTP_TEMPLATE_NAME: settings.templateName,
  WHATSAPP_OTP_TEMPLATE_LANGUAGE: settings.language,
};
const accepted = () =>
  Response.json({ messaging_product: 'whatsapp', messages: [{ id: 'wamid.synthetic' }] });

afterEach(() => vi.restoreAllMocks());

describe('Meta WhatsApp authentication delivery', () => {
  it('sends the code in the body and copy-code button using the approved template', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(accepted());
    await new MetaWhatsAppOtpSender(settings, fetcher).send('+919876543210', '012345');
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, request] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://graph.facebook.com/v23.0/123456789/messages');
    expect(request).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: { Authorization: 'Bearer synthetic-meta-token' },
    });
    expect(request?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(request!.body as string)).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '919876543210',
      type: 'template',
      template: {
        name: 'patient_sign_in',
        language: { code: 'en_US' },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: '012345' }] },
          {
            type: 'button',
            sub_type: 'url',
            index: '0',
            parameters: [{ type: 'text', text: '012345' }],
          },
        ],
      },
    });
  });

  it.each([400, 401, 429, 500])(
    'returns a safe error and does not retry HTTP %s',
    async (status) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json({ error: 'synthetic-meta-token +919876543210 012345' }, { status }),
        );
      const error = await new MetaWhatsAppOtpSender(settings, fetcher)
        .send('+919876543210', '012345')
        .catch((e: unknown) => e);
      expect(error).toMatchObject({ statusCode: 503, code: 'UNAVAILABLE' });
      expect(error).not.toHaveProperty('cause');
      expect(String(error)).not.toMatch(/synthetic-meta-token|9876543210|012345/);
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );

  it('retains only numeric rejection diagnostics', async () => {
    const secret = 'synthetic-meta-token +919876543210 012345';
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          error: { code: 131030, message: secret, error_data: { details: secret } },
        },
        { status: 400 },
      ),
    );
    const error = await new MetaWhatsAppOtpSender(settings, fetcher)
      .send('+919876543210', '012345')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OtpDeliveryError);
    expect(error).toMatchObject({ providerCode: 131030, providerHttpStatus: 400 });
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(String(error)).not.toContain(secret);
    expect(error).not.toHaveProperty('cause');
    expect(error).not.toHaveProperty('error_data');
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each(['131030', -1, 1.5, 2147483648, null])(
    'discards invalid provider code %s',
    async (code) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ error: { code } }, { status: 400 }));
      const error = await new MetaWhatsAppOtpSender(settings, fetcher)
        .send('+919876543210', '012345')
        .catch((e: unknown) => e);
      expect(error).toMatchObject({ providerHttpStatus: 400 });
      expect((error as OtpDeliveryError).providerCode).toBeUndefined();
    },
  );

  it.each([200, 400])('bounds provider response size for HTTP %s', async (status) => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('x'.repeat(16385)));
      },
      cancel,
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status }));
    const error = await new MetaWhatsAppOtpSender(settings, fetcher)
      .send('+919876543210', '012345')
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ statusCode: 503, code: 'UNAVAILABLE' });
    expect((error as OtpDeliveryError).providerCode).toBeUndefined();
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([{}, { messages: [] }, { messaging_product: 'whatsapp', messages: [{ id: '' }] }])(
    'refuses an unconfirmed success payload %j',
    async (body) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body));
      await expect(
        new MetaWhatsAppOtpSender(settings, fetcher).send('+919876543210', '012345'),
      ).rejects.toMatchObject({ statusCode: 503 });
    },
  );

  it('sanitizes network failures and invalid JSON', async () => {
    for (const fetcher of [
      vi.fn<typeof fetch>().mockRejectedValue(new Error('synthetic-meta-token 012345')),
      vi.fn<typeof fetch>().mockResolvedValue(new Response('not json')),
    ]) {
      await expect(
        new MetaWhatsAppOtpSender(settings, fetcher).send('+919876543210', '012345'),
      ).rejects.toMatchObject({ statusCode: 503, code: 'UNAVAILABLE' });
    }
  });

  it('aborts a stalled provider request', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      (_url, request) =>
        new Promise((_resolve, reject) => {
          request!.signal!.addEventListener('abort', () => reject(request!.signal!.reason), {
            once: true,
          });
        }),
    );
    await expect(
      new MetaWhatsAppOtpSender(settings, fetcher, 10).send('+919876543210', '012345'),
    ).rejects.toMatchObject({ statusCode: 503 });
  });

  it.each([
    ['9876543210', '012345'],
    ['+919876543210', 'bad'],
    ['+919876543210/path', '012345'],
  ])('does not send malformed recipient/code', async (phone, code) => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      new MetaWhatsAppOtpSender(settings, fetcher).send(phone!, code!),
    ).rejects.toMatchObject({ statusCode: 503 });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('OTP provider configuration', () => {
  it('requires every Meta setting when WhatsApp is selected, including in production', () => {
    expect(createOtpSender(loadConfig({ ...env, NODE_ENV: 'production' }))).toBeInstanceOf(
      MetaWhatsAppOtpSender,
    );
    for (const key of Object.keys(env).filter((key) => key !== 'OTP_DELIVERY')) {
      const incomplete: Record<string, string> = { ...env };
      delete incomplete[key];
      expect(() => loadConfig(incomplete), key).toThrow(/Invalid environment/);
    }
  });

  it.each([
    ['WHATSAPP_GRAPH_API_VERSION', '../v23.0'],
    ['WHATSAPP_PHONE_NUMBER_ID', '123/messages'],
    ['WHATSAPP_ACCESS_TOKEN', 'bad\nheader'],
    ['WHATSAPP_OTP_TEMPLATE_NAME', 'invalid template'],
    ['WHATSAPP_OTP_TEMPLATE_LANGUAGE', 'en_US/path'],
  ])('rejects invalid %s', (key, value) => {
    expect(() => loadConfig({ ...env, [key!]: value })).toThrow(/Invalid environment/);
  });

  it('does not send when delivery is disabled', async () => {
    await expect(
      createOtpSender(loadConfig({})).send('+919876543210', '012345'),
    ).rejects.toMatchObject({ statusCode: 503 });
  });
});
