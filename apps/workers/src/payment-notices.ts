import { withMessaging, type Db } from '@dhc/db';
import { Queue, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { z } from 'zod';
import { createFinanceLinkToken } from '@dhc/secure-links';
import type { WorkerConfig } from './config';
import { DEFAULT_JOB_OPTIONS } from './queues';
import { publishReceipts } from './whatsapp-status';

export interface PaymentNotice {
  phone: string;
  organisation_slug: string;
  link_expires_at: Date;
}

export class NoticeSendFailure extends Error {
  constructor(readonly result: 'submission_failed' | 'uncertain') {
    super('WhatsApp payment submission could not be confirmed');
  }
}

export async function sendPaymentNotice(
  config: WorkerConfig,
  id: string,
  notice: PaymentNotice,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const token = createFinanceLinkToken(
    id,
    notice.link_expires_at,
    config.WHATSAPP_PAYMENT_LINK_SECRET!,
  );
  const link = new URL(`/app/payments/notice/${token}`, config.WEB_BASE_URL);
  link.searchParams.set('clinic', notice.organisation_slug);
  const language = config.WHATSAPP_PAYMENT_TEMPLATE_LANGUAGE!;
  const parameters = [link.toString()];
  try {
    const response = await fetcher(
      `https://graph.facebook.com/${config.WHATSAPP_GRAPH_API_VERSION}/${config.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
        headers: {
          Authorization: `Bearer ${config.WHATSAPP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: notice.phone.slice(1),
          biz_opaque_callback_data: id,
          type: 'template',
          template: {
            name: config.WHATSAPP_PAYMENT_TEMPLATE,
            language: { code: language },
            components: [
              { type: 'body', parameters: parameters.map((text) => ({ type: 'text', text })) },
            ],
          },
        }),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new NoticeSendFailure(
        response.status >= 400 && response.status < 500 ? 'submission_failed' : 'uncertain',
      );
    }
    const accepted = z
      .object({
        messaging_product: z.literal('whatsapp'),
        messages: z.array(z.object({ id: z.string().min(1).max(512) })).min(1),
      })
      .parse(await response.json());
    return accepted.messages[0]!.id;
  } catch (e) {
    if (e instanceof NoticeSendFailure) throw e;
    // Never retain a response body, recipient or access token in job failures or logs.
    throw new NoticeSendFailure('uncertain');
  }
}

export function paymentNoticeProcessor(db: Db, config: WorkerConfig) {
  return async (job: Job) => {
    if (job.name !== 'payment-notice') throw new Error('Unknown messaging job');
    const { deliveryId } = z.object({ deliveryId: z.uuid() }).strict().parse(job.data);
    const sender = config.WHATSAPP_PHONE_NUMBER_ID!;
    const [notice] = await withMessaging(
      db,
      (tx) => tx.$queryRaw<PaymentNotice[]>`
      SELECT * FROM messaging_begin_payment_notice(${deliveryId}::uuid, ${sender})`,
    );
    if (!notice) return;
    let message: string | null = null;
    let result: 'accepted' | 'submission_failed' | 'uncertain' = 'accepted';
    try {
      message = await sendPaymentNotice(config, deliveryId, notice);
    } catch (e) {
      result = e instanceof NoticeSendFailure ? e.result : 'uncertain';
    }
    await withMessaging(
      db,
      (tx) => tx.$executeRaw`
      SELECT messaging_finish_payment_notice(${deliveryId}::uuid, ${sender}, ${result}, ${message})`,
    );
  };
}

export function startPaymentDispatch(db: Db, config: WorkerConfig) {
  const connection = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 5_000,
    commandTimeout: 5_000,
  });
  connection.on('error', () => {});
  const queue = new Queue('messaging', { connection, skipWaitingForReady: true });
  queue.on('error', () => {});
  let active: Promise<void> | undefined;
  let stopping = false;
  const tick = () => {
    if (active || stopping) return;
    active = publishReceipts(
      () =>
        withMessaging(
          db,
          (tx) =>
            tx.$queryRaw<
              { id: string }[]
            >`SELECT id FROM messaging_claim_payment_notices(${config.WHATSAPP_PHONE_NUMBER_ID!})`,
        ),
      (deliveryId) =>
        queue.add(
          'payment-notice',
          { deliveryId },
          { ...DEFAULT_JOB_OPTIONS, jobId: `wa-payment-${deliveryId}` },
        ),
    )
      .catch(() => console.error('Payment dispatch unavailable; durable outbox will retry'))
      .finally(() => {
        active = undefined;
      });
  };
  const timer = setInterval(tick, 10_000);
  timer.unref();
  tick();
  return async () => {
    stopping = true;
    clearInterval(timer);
    await active;
    await queue.close();
    connection.disconnect();
  };
}
