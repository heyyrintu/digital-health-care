import Fastify from 'fastify';
import { createHmac } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerErrorHandling } from '../errors';
import { loadConfig } from '../config';
import type { Services } from '../services';
import { statusReceipts, stopRequests, validSignature, whatsappWebhookRoutes } from './webhooks';

const fake = vi.hoisted(() => ({ query: vi.fn(), execute: vi.fn() }));
vi.mock('@dhc/db', () => ({
  withMessaging: async (_db: unknown, run: (tx: unknown) => unknown) =>
    run({ $queryRaw: fake.query, $executeRaw: fake.execute }),
}));
const config = {
  appSecret: 'synthetic-app-secret',
  verifyToken: 'synthetic-verification-token-32-characters',
  senderId: '1234',
  businessAccountId: '5678',
};
const services = { db: {}, whatsappWebhook: config } as Services;
const logs: string[] = [];
const app = Fastify({
  logger: {
    level: 'info',
    stream: {
      write: (line: string) => {
        logs.push(line);
      },
    },
  },
});
registerErrorHandling(app);
app.post('/ordinary', async (req) => req.body);
app.register(whatsappWebhookRoutes, { prefix: '/v1', services });
afterAll(() => app.close());
beforeEach(() => {
  fake.query.mockReset().mockResolvedValue([{ messaging_receive_status: 'stored' }]);
  fake.execute.mockReset().mockResolvedValue(1);
  logs.length = 0;
});

const payload = (status = 'delivered') => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: '5678',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { phone_number_id: '1234' },
            statuses: [
              {
                id: 'wamid.synthetic',
                status,
                timestamp: '1793793600',
                recipient_id: '919876543210',
                errors: [{ code: 131026, message: 'sensitive provider detail' }],
              },
            ],
          },
        },
      ],
    },
  ],
});
const signature = (raw: string) =>
  'sha256=' + createHmac('sha256', config.appSecret).update(raw).digest('hex');
const post = (raw: string, sig = signature(raw)) =>
  app.inject({
    method: 'POST',
    url: '/v1/webhooks/whatsapp',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig },
    payload: raw,
  });

describe('Meta callback verification and extraction', () => {
  it('echoes the challenge as text without logging the URL token', async () => {
    const r = await app.inject({
      url: `/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${config.verifyToken}&hub.challenge=12345`,
    });
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe('12345');
    expect(r.headers['content-type']).toContain('text/plain');
    expect(logs.join('')).not.toContain(config.verifyToken);
  });
  it('refuses a bad verification token and malformed challenge', async () => {
    for (const query of [
      'hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=123',
      `hub.mode=subscribe&hub.verify_token=${config.verifyToken}&hub.challenge=<script>`,
    ]) {
      expect((await app.inject({ url: '/v1/webhooks/whatsapp?' + query })).statusCode).toBe(403);
    }
  });
  it('checks exact raw bytes and rejects malformed signatures before JSON parsing', async () => {
    const raw = JSON.stringify(payload());
    expect(validSignature(Buffer.from(raw), signature(raw), config.appSecret)).toBe(true);
    expect((await post(raw + ' ', signature(raw))).statusCode).toBe(401);
    for (const sig of ['', 'sha256=bad', 'sha256=' + '0'.repeat(64)])
      expect((await post('{', sig)).statusCode).toBe(401);
    expect(fake.query).not.toHaveBeenCalled();
  });
  it('saves sanitized receipts only and preserves ordinary JSON parsing', async () => {
    expect((await post(JSON.stringify(payload()))).statusCode).toBe(200);
    expect(fake.query).toHaveBeenCalledOnce();
    const serialized = JSON.stringify(fake.query.mock.calls);
    expect(serialized).not.toContain('9876543210');
    expect(serialized).not.toContain('sensitive provider detail');
    expect(
      (await app.inject({ method: 'POST', url: '/ordinary', payload: { ok: true } })).json(),
    ).toEqual({ ok: true });
  });
  it('acknowledges unrelated accounts, senders and unsupported status kinds without writing', async () => {
    const otherAccount = payload();
    otherAccount.entry[0]!.id = 'other';
    const otherSender = payload();
    otherSender.entry[0]!.changes[0]!.value.metadata.phone_number_id = 'other';
    for (const body of [otherAccount, otherSender, payload('deleted')])
      expect((await post(JSON.stringify(body))).statusCode).toBe(200);
    expect(fake.query).not.toHaveBeenCalled();
  });
  it('returns 503 on storage failure so Meta can retry; hides database errors', async () => {
    fake.query.mockRejectedValue(new Error('sensitive database detail'));
    const r = await post(JSON.stringify(payload()));
    expect(r.statusCode).toBe(503);
    expect(r.body).not.toContain('sensitive');
  });
  it('rejects malformed JSON, invalid timestamps and oversized callbacks', async () => {
    expect((await post('{')).statusCode).toBe(400);
    expect((await post(' '.repeat(256 * 1024 + 1))).statusCode).toBe(413);
    const body = payload();
    body.entry[0]!.changes[0]!.value.statuses[0]!.timestamp = '999999999999';
    expect(() => statusReceipts(body, '1234', '5678')).toThrow();
  });
  it('recognizes STOP only for the configured account and sender, discarding other inbound text', async () => {
    const body = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '5678',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: '1234' },
                messages: [
                  {
                    id: 'wamid.stop',
                    from: '919876543210',
                    timestamp: '1793793600',
                    type: 'text',
                    text: { body: ' STOP ' },
                  },
                  {
                    id: 'wamid.other',
                    from: '919876543210',
                    timestamp: '1793793600',
                    type: 'text',
                    text: { body: 'private chat' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const stops = stopRequests(body, '1234', '5678');
    expect(stops).toHaveLength(1);
    expect(stops[0]!.eventId).toMatch(/^[a-f0-9]{64}$/);
    expect(stops[0]).not.toHaveProperty('text');
    expect(stopRequests(body, 'other', '5678')).toEqual([]);
    expect((await post(JSON.stringify(body))).statusCode).toBe(200);
    expect(fake.execute).toHaveBeenCalledOnce();
  });
  it('requires callbacks when appointment messaging is enabled', () => {
    expect(() => loadConfig({ WHATSAPP_APPOINTMENTS_ENABLED: 'true' })).toThrow(
      /WHATSAPP_WEBHOOK_ENABLED/,
    );
  });
  it('requires explicit, complete webhook configuration', () => {
    expect(loadConfig({}).WHATSAPP_WEBHOOK_ENABLED).toBe(false);
    expect(() => loadConfig({ WHATSAPP_WEBHOOK_ENABLED: 'true' })).toThrow(/WHATSAPP_APP_SECRET/);
    expect(
      loadConfig({
        WHATSAPP_WEBHOOK_ENABLED: 'true',
        WHATSAPP_APP_SECRET: config.appSecret,
        WHATSAPP_WEBHOOK_VERIFY_TOKEN: config.verifyToken,
        WHATSAPP_PHONE_NUMBER_ID: '1234',
        WHATSAPP_BUSINESS_ACCOUNT_ID: '5678',
      }).WHATSAPP_WEBHOOK_ENABLED,
    ).toBe(true);
  });
});
