import { withMessaging, type Db } from '@dhc/db';
import { createReviewLinkToken } from '@dhc/secure-links';
import { Queue, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { z } from 'zod';
import type { WorkerConfig } from './config';
import { NoticeSendFailure } from './appointment-notices';
import { DEFAULT_JOB_OPTIONS } from './queues';
import { publishReceipts } from './whatsapp-status';
export interface ReviewNotice {
  phone: string;
  clinic_name: string;
  expires_at: Date;
}
export async function sendReviewNotice(
  config: WorkerConfig,
  id: string,
  notice: ReviewNotice,
  fetcher: typeof fetch = fetch,
) {
  const link = new URL('/review', config.WEB_BASE_URL);
  link.hash = createReviewLinkToken(id, notice.expires_at, config.WHATSAPP_REVIEW_LINK_SECRET!);
  try {
    const response = await fetcher(
      `https://graph.facebook.com/${config.WHATSAPP_GRAPH_API_VERSION}/${config.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
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
            name: config.WHATSAPP_REVIEW_TEMPLATE,
            language: { code: config.WHATSAPP_REVIEW_TEMPLATE_LANGUAGE },
            components: [
              {
                type: 'body',
                parameters: [notice.clinic_name, link.toString()].map((text) => ({
                  type: 'text',
                  text,
                })),
              },
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
    const body = z
      .object({
        messaging_product: z.literal('whatsapp'),
        messages: z.array(z.object({ id: z.string().min(1).max(512) })).min(1),
      })
      .parse(await response.json());
    return body.messages[0]!.id;
  } catch (e) {
    if (e instanceof NoticeSendFailure) throw e;
    throw new NoticeSendFailure('uncertain');
  }
}
export function reviewNoticeProcessor(db: Db, config: WorkerConfig) {
  return async (job: Job) => {
    if (job.name !== 'review-request') throw new Error('Unknown review job');
    const { deliveryId } = z.object({ deliveryId: z.uuid() }).strict().parse(job.data),
      sender = config.WHATSAPP_PHONE_NUMBER_ID!;
    const [notice] = await withMessaging(
      db,
      (tx) =>
        tx.$queryRaw<
          ReviewNotice[]
        >`SELECT * FROM messaging_begin_review_notice(${deliveryId}::uuid,${sender})`,
    );
    if (!notice) return;
    let message: string | null = null,
      result: 'accepted' | 'submission_failed' | 'uncertain' = 'accepted';
    try {
      message = await sendReviewNotice(config, deliveryId, notice);
    } catch (e) {
      result = e instanceof NoticeSendFailure ? e.result : 'uncertain';
    }
    await withMessaging(
      db,
      (tx) =>
        tx.$executeRaw`SELECT messaging_finish_review_notice(${deliveryId}::uuid,${sender},${result},${message})`,
    );
  };
}
export function startReviewDispatch(db: Db, config: WorkerConfig) {
  const connection = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 5000,
    commandTimeout: 5000,
  });
  connection.on('error', () => {});
  const queue = new Queue('messaging', { connection, skipWaitingForReady: true });
  queue.on('error', () => {});
  let active: Promise<void> | undefined,
    stopping = false;
  const tick = () => {
    if (active || stopping) return;
    active = publishReceipts(
      () =>
        withMessaging(
          db,
          (tx) =>
            tx.$queryRaw<
              { id: string }[]
            >`SELECT id FROM messaging_claim_review_notices(${config.WHATSAPP_PHONE_NUMBER_ID!})`,
        ),
      (deliveryId) =>
        queue.add(
          'review-request',
          { deliveryId },
          { ...DEFAULT_JOB_OPTIONS, jobId: `wa-review-${deliveryId}` },
        ),
    )
      .catch(() => console.error('Review dispatch unavailable; durable outbox will retry'))
      .finally(() => {
        active = undefined;
      });
  };
  const timer = setInterval(tick, 10000);
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
