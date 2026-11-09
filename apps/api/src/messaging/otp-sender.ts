import { z } from 'zod';
import type { Config } from '../config';
import { AppError } from '../errors';
import type { OtpSender } from '../services';
import { boundedMetaJson } from './meta-response';

const Accepted = z.object({
  messaging_product: z.literal('whatsapp'),
  messages: z.array(z.object({ id: z.string().min(1).max(512) })).min(1),
});

type MetaOtpConfig = {
  accessToken: string;
  phoneNumberId: string;
  version: string;
  templateName: string;
  language: string;
};

const ProviderCode = z.number().int().min(0).max(2147483647);
const Rejected = z.object({ error: z.object({ code: ProviderCode }) });

/** Only numeric diagnostics survive; no provider text, request, response or cause is retained. */
export class OtpDeliveryError extends AppError {
  readonly providerCode?: number;
  readonly providerHttpStatus?: number;
  constructor(providerCode?: unknown, providerHttpStatus?: unknown) {
    super(503, 'UNAVAILABLE', 'We could not send your sign-in code. Please try again later.');
    const code = ProviderCode.safeParse(providerCode);
    if (code.success) this.providerCode = code.data;
    const status = z.number().int().min(400).max(599).safeParse(providerHttpStatus);
    if (status.success) this.providerHttpStatus = status.data;
  }
}

const unavailable = () => new OtpDeliveryError();

/** Only authentication templates; clinical content never passes through this adapter. */
export class MetaWhatsAppOtpSender implements OtpSender {
  readonly channel = 'whatsapp' as const;
  get senderId() {
    return this.config.phoneNumberId;
  }
  constructor(
    private readonly config: MetaOtpConfig,
    private readonly fetcher: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
  ) {}

  async send(phone: string, code: string, deliveryId?: string): Promise<{ messageId: string }> {
    if (!/^\+91[6-9]\d{9}$/.test(phone) || !/^\d{6}$/.test(code)) throw unavailable();
    const { accessToken, phoneNumberId, version, templateName, language } = this.config;
    try {
      const response = await this.fetcher(
        `https://graph.facebook.com/${version}/${phoneNumberId}/messages`,
        {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(this.timeoutMs),
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: phone.slice(1),
            ...(deliveryId ? { biz_opaque_callback_data: deliveryId } : {}),
            type: 'template',
            template: {
              name: templateName,
              language: { code: language },
              components: [
                { type: 'body', parameters: [{ type: 'text', text: code }] },
                {
                  type: 'button',
                  sub_type: 'url',
                  index: '0',
                  parameters: [{ type: 'text', text: code }],
                },
              ],
            },
          }),
        },
      );
      if (!response.ok) {
        let code: number | undefined;
        try {
          const parsed = Rejected.safeParse(await boundedMetaJson(response, 16384));
          if (parsed.success) code = parsed.data.error.code;
        } catch {
          // Invalid, oversized or interrupted bodies provide no trustworthy code.
        }
        throw new OtpDeliveryError(code, response.status);
      }
      const accepted = Accepted.parse(await boundedMetaJson(response, 16384));
      return { messageId: accepted.messages[0]!.id };
    } catch (error) {
      // Provider errors can echo the recipient, token or code. Do not propagate their
      // response body, exception or cause into Fastify logs or the public error.
      if (error instanceof OtpDeliveryError) throw error;
      throw unavailable();
    }
  }
}

export function createOtpSender(config: Config): OtpSender {
  if (config.OTP_DELIVERY === 'whatsapp') {
    const {
      WHATSAPP_ACCESS_TOKEN: accessToken,
      WHATSAPP_PHONE_NUMBER_ID: phoneNumberId,
      WHATSAPP_GRAPH_API_VERSION: version,
      WHATSAPP_OTP_TEMPLATE_NAME: templateName,
      WHATSAPP_OTP_TEMPLATE_LANGUAGE: language,
    } = config;
    if (!accessToken || !phoneNumberId || !version || !templateName || !language) {
      throw new Error('WhatsApp OTP configuration is incomplete');
    }
    return new MetaWhatsAppOtpSender({
      accessToken,
      phoneNumberId,
      version,
      templateName,
      language,
    });
  }
  if (config.OTP_DELIVERY === 'log') {
    return {
      send: async (phone, code) => console.warn(`[DEV ONLY] Sign-in code for ${phone}: ${code}`),
    };
  }
  return {
    send: async () => {
      throw unavailable();
    },
  };
}
