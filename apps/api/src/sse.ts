import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Services } from './services';

/** Comments keep proxies from closing an idle stream. */
const HEARTBEAT_MS = 25_000;

/**
 * Streams the organisation's queue changes for one IST day as server-sent events:
 * `ready` once listening, then `queue` with `{appointmentId}` for each changed visit.
 * The client refetches what it shows; the stream carries no patient data. Ends when the
 * client disconnects. Headers set earlier (CORS, request ID) are kept.
 */
export async function streamQueue(
  services: Services,
  request: FastifyRequest,
  reply: FastifyReply,
  organisationId: string,
  date: string,
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

  const send = (event: string, data: unknown) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const unsubscribe = await services.live.subscribe(organisationId, date, (change) =>
    send('queue', { appointmentId: change.appointmentId }),
  );
  send('ready', { date });
  const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), HEARTBEAT_MS);
  heartbeat.unref();

  request.raw.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}
