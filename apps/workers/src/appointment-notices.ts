import { withMessaging, type Db } from '@dhc/db';
import { Queue, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { z } from 'zod';
import type { WorkerConfig } from './config';
import { DEFAULT_JOB_OPTIONS } from './queues';
import { publishReceipts } from './whatsapp-status';

export interface AppointmentNotice {
  phone: string;
  kind: 'appointment_confirmation' | 'appointment_reminder' | 'appointment_update';
  clinic_name: string;
  organisation_slug: string;
  start_at: Date;
}

export class NoticeSendFailure extends Error {
  constructor(readonly result: 'submission_failed' | 'uncertain') {
    super('WhatsApp appointment submission could not be confirmed');
  }
}

export async function sendAppointmentNotice(
  config: WorkerConfig,
  id: string,
  notice: AppointmentNotice,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const link = new URL('/app/login', config.WEB_BASE_URL);
  link.searchParams.set('clinic', notice.organisation_slug);
  const language =
    notice.kind === 'appointment_update'
      ? config.WHATSAPP_OPERATION_TEMPLATE_LANGUAGE!
      : config.WHATSAPP_APPOINTMENT_TEMPLATE_LANGUAGE!;
  const locale = language.replace('_', '-');
  const parameters =
    notice.kind === 'appointment_update'
      ? [notice.clinic_name, link.toString()]
      : [
          notice.clinic_name,
          new Intl.DateTimeFormat(locale, {
            timeZone: 'Asia/Kolkata',
            day: '2-digit',
            month: 'short',
            year: 'numeric',
          }).format(notice.start_at),
          new Intl.DateTimeFormat(locale, {
            timeZone: 'Asia/Kolkata',
            hour: '2-digit',
            minute: '2-digit',
            hour12: true,
          }).format(notice.start_at),
          link.toString(),
        ];
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
            name:
              notice.kind === 'appointment_update'
                ? config.WHATSAPP_OPERATION_TEMPLATE
                : notice.kind === 'appointment_confirmation'
                  ? config.WHATSAPP_APPOINTMENT_CONFIRMATION_TEMPLATE
                  : config.WHATSAPP_APPOINTMENT_REMINDER_TEMPLATE,
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

export function appointmentNoticeProcessor(db: Db, config: WorkerConfig) {
  return async (job: Job) => {
    if (job.name !== 'appointment-notice') throw new Error('Unknown messaging job');
    const { deliveryId } = z.object({ deliveryId: z.uuid() }).strict().parse(job.data);
    const sender = config.WHATSAPP_PHONE_NUMBER_ID!;
    const [notice] = await withMessaging(
      db,
      (tx) => tx.$queryRaw<AppointmentNotice[]>`
      SELECT * FROM messaging_begin_appointment_notice(${deliveryId}::uuid, ${sender})`,
    );
    if (!notice) return;
    let message: string | null = null;
    let result: 'accepted' | 'submission_failed' | 'uncertain' = 'accepted';
    try {
      message = await sendAppointmentNotice(config, deliveryId, notice);
    } catch (e) {
      result = e instanceof NoticeSendFailure ? e.result : 'uncertain';
    }
    await withMessaging(
      db,
      (tx) => tx.$executeRaw`
      SELECT messaging_finish_appointment_notice(${deliveryId}::uuid, ${sender}, ${result}, ${message})`,
    );
  };
}

export function startAppointmentDispatch(db: Db, config: WorkerConfig) {
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
            >`SELECT id FROM messaging_claim_appointment_notices(${config.WHATSAPP_PHONE_NUMBER_ID!})`,
        ),
      (deliveryId) =>
        queue.add(
          'appointment-notice',
          { deliveryId },
          { ...DEFAULT_JOB_OPTIONS, jobId: `wa-notice-${deliveryId}` },
        ),
    )
      .catch(() => console.error('Appointment dispatch unavailable; durable outbox will retry'))
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
