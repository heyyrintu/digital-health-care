import { z } from 'zod';
export const InboxChannels = z
  .array(
    z
      .object({
        organisationId: z.uuid(),
        senderId: z.string().regex(/^\d+$/),
        businessId: z.string().regex(/^\d+$/),
      })
      .strict(),
  )
  .min(1)
  .max(100);
export type InboxChannelConfig = z.infer<typeof InboxChannels>[number];
export function parseInboxChannels(raw: string) {
  const rows = InboxChannels.parse(JSON.parse(raw));
  if (
    new Set(rows.map((r) => r.senderId)).size !== rows.length ||
    new Set(rows.map((r) => r.organisationId)).size !== rows.length
  )
    throw new Error('Each inbox clinic and sender must be unique');
  return rows;
}
const ProviderTemplate = z.object({
  id: z.string().regex(/^\d+$/),
  name: z
    .string()
    .regex(/^[a-z0-9_]+$/)
    .max(512),
  language: z.string().max(20),
  category: z.string().max(32),
  status: z.string().max(40),
  components: z
    .array(z.object({ type: z.string(), text: z.string().max(4096).optional() }).passthrough())
    .max(20),
});
export type ProviderTemplate = z.infer<typeof ProviderTemplate>;
export interface InboxGateway {
  templates(channel: InboxChannelConfig): Promise<ProviderTemplate[]>;
  send(
    channel: InboxChannelConfig,
    body: { to: string; id: string; text?: string; template?: { name: string; language: string } },
  ): Promise<{
    state: 'accepted' | 'failed' | 'uncertain';
    messageId?: string;
    errorCode?: number;
  }>;
}
async function boundedJson(response: Response, max = 2 * 1048576): Promise<unknown> {
  if (!response.body) throw new Error('Empty provider response');
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const r = await reader.read();
      if (r.done) break;
      size += r.value.length;
      if (size > max) throw new Error('Provider response exceeds limit');
      chunks.push(r.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export class MetaInboxGateway implements InboxGateway {
  constructor(
    readonly token: string,
    readonly version: string,
    readonly fetcher: typeof fetch = fetch,
  ) {}
  async templates(channel: InboxChannelConfig) {
    const rows: ProviderTemplate[] = [];
    let after: string | undefined;
    for (let page = 0; page < 10; page++) {
      const url = new URL(
        `https://graph.facebook.com/${this.version}/${channel.businessId}/message_templates`,
      );
      url.searchParams.set('fields', 'id,name,language,category,status,components');
      url.searchParams.set('limit', '100');
      if (after) url.searchParams.set('after', after);
      const r = await this.fetcher(url, {
        headers: { Authorization: `Bearer ${this.token}` },
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) throw new Error('Template synchronization unavailable');
      const parsed = z
        .object({
          data: z.array(ProviderTemplate).max(100),
          paging: z
            .object({
              next: z.string().optional(),
              cursors: z.object({ after: z.string().max(2048).optional() }).optional(),
            })
            .optional(),
        })
        .parse(await boundedJson(r));
      rows.push(...parsed.data);
      if (!parsed.paging?.next) return rows;
      after = parsed.paging.cursors?.after;
      if (!after) throw new Error('Incomplete template list');
    }
    throw new Error('Template list exceeds limit');
  }
  async send(
    channel: InboxChannelConfig,
    body: { to: string; id: string; text?: string; template?: { name: string; language: string } },
  ) {
    try {
      const r = await this.fetcher(
        `https://graph.facebook.com/${this.version}/${channel.senderId}/messages`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
          redirect: 'error',
          signal: AbortSignal.timeout(10000),
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: body.to.slice(1),
            biz_opaque_callback_data: body.id,
            ...(body.template
              ? {
                  type: 'template',
                  template: {
                    name: body.template.name,
                    language: { code: body.template.language },
                  },
                }
              : { type: 'text', text: { preview_url: false, body: body.text } }),
          }),
        },
      );
      const json = await boundedJson(r, 65536);
      if (r.ok) {
        const p = z
          .object({ messages: z.array(z.object({ id: z.string().min(1).max(512) })).length(1) })
          .parse(json);
        return { state: 'accepted' as const, messageId: p.messages[0]!.id };
      }
      const code = z
        .object({ error: z.object({ code: z.number().int().min(0).max(2147483647) }) })
        .safeParse(json);
      return {
        state: r.status >= 400 && r.status < 500 ? ('failed' as const) : ('uncertain' as const),
        ...(code.success ? { errorCode: code.data.error.code } : {}),
      };
    } catch {
      return { state: 'uncertain' as const };
    }
  }
}
