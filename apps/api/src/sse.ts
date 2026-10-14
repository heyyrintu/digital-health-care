import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Services } from './services';

/** Comments keep proxies from closing an idle stream. */
const HEARTBEAT_MS = 25_000;
const DAY_MS = 86_400_000;
const IST_OFFSET_MS = 330 * 60_000;

/** The next midnight in India, as epoch milliseconds. */
export function nextIstMidnight(now: Date): number {
  const ist = now.getTime() + IST_OFFSET_MS;
  return Math.floor(ist / DAY_MS) * DAY_MS + DAY_MS - IST_OFFSET_MS;
}

export interface StreamOptions {
  /** Only this clinic's visits (a waiting-room screen); staff hear the whole organisation. */
  clinicId?: string;
  /** End the stream at this time (epoch ms), e.g. when "today" rolls over; clients reconnect. */
  endAt?: number;
  /** Checked before each event and heartbeat; the stream ends once it returns false. */
  stillAllowed?: () => Promise<boolean>;
}

/**
 * Streams the organisation's queue changes for one IST day as server-sent events:
 * `ready` once listening, then `queue` with `{appointmentId}` for each changed visit.
 * The client refetches what it shows; the stream carries no patient data. Ends when the
 * client disconnects, at `endAt`, or once `stillAllowed` says no. Headers set earlier
 * (CORS, request ID) are kept.
 */
export async function streamQueue(
  services: Services,
  request: FastifyRequest,
  reply: FastifyReply,
  organisationId: string,
  date: string,
  options: StreamOptions = {},
): Promise<void> {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    ...(reply.getHeaders() as Record<string, string>),
    'x-request-id': request.id,
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  let ended = false;
  let unsubscribe: (() => void) | undefined;
  const timers: { heartbeat?: NodeJS.Timeout; rollover?: NodeJS.Timeout } = {};
  const end = () => {
    if (ended) return;
    ended = true;
    clearInterval(timers.heartbeat);
    clearTimeout(timers.rollover);
    unsubscribe?.();
    res.end();
  };
  // Registered first, so a client that leaves while we subscribe is still cleaned up. On
  // the response: a POST's request has already ended once its body was read.
  res.on('close', end);

  const allowed = async () => {
    if (!options.stillAllowed) return true;
    const ok = await options.stillAllowed().catch(() => false);
    if (!ok) end();
    return ok && !ended;
  };
  const send = (event: string, data: unknown) => {
    if (!ended) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const stop = await services.live.subscribe(organisationId, date, (change) => {
      if (options.clinicId && change.clinicId !== options.clinicId) return;
      void allowed().then((ok) => ok && send('queue', { appointmentId: change.appointmentId }));
    });
    if (ended) return stop();
    unsubscribe = stop;
  } catch (error) {
    request.log.error({ err: error }, 'queue stream could not subscribe');
    return end();
  }

  send('ready', { date });
  timers.heartbeat = setInterval(() => {
    void allowed().then((ok) => ok && res.write(': keep-alive\n\n'));
  }, HEARTBEAT_MS);
  timers.heartbeat.unref();
  if (options.endAt !== undefined) {
    timers.rollover = setTimeout(end, Math.max(0, options.endAt - services.now().getTime()));
    timers.rollover.unref();
  }
}
