import { afterTenantWork, Prisma, withAuth, withTenant, type Tx } from '@dhc/db';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { AppError } from './errors';
import { authOf } from './plugins/authenticate';
import type { Services } from './services';

/** How long a key's first result is replayed (API guide §2). */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const KEY = /^[A-Za-z0-9_-]{8,100}$/;
/**
 * A key still unanswered this long after its claim, with no write recorded, belongs to a
 * request that died (a transaction times out within seconds), so a retry may run.
 */
export const ABANDONED_AFTER_MS = 60_000;

export interface WriteResult {
  status: number;
  body: unknown;
}

/**
 * Runs a retryable write at most once per `Idempotency-Key` (API guide §2). The same
 * person sending the same key and body again within 24 hours gets the first response,
 * with an `idempotent-replay: true` header. A different body under the same key is 409,
 * and so is a retry that arrives while the first request is still running, so a double
 * tap never records two payments. Without the header the write simply runs.
 *
 * The key is claimed before the write and the result stored after it. Each transaction
 * of the write that changes data also marks the key, atomically, so a retry can tell a
 * request that died before writing (it may run again once abandoned) from one whose
 * response was lost (409 `unknown`); it never runs a write twice. A write that fails
 * without changing anything releases the key so the client can retry.
 */
export async function idempotent(
  services: Services,
  request: FastifyRequest,
  reply: FastifyReply,
  write: () => Promise<WriteResult>,
): Promise<FastifyReply> {
  const header = request.headers['idempotency-key'];
  if (header === undefined) return send(reply, await write());
  const key = Array.isArray(header) ? header[0] : header;
  if (!key || !KEY.test(key)) {
    throw new AppError(
      400,
      'VALIDATION_FAILED',
      'Idempotency-Key must be 8–100 letters, digits, - or _.',
      {
        idempotencyKey: 'invalid',
      },
    );
  }
  const actor = authOf(request);
  const path = request.url.split('?')[0]!;
  const requestHash = createHash('sha256')
    .update(`${request.method} ${path}\n${JSON.stringify(request.body ?? null)}`)
    .digest('hex');
  const id = { organisationId: actor.organisationId, userId: actor.userId, key };
  const where = { organisationId_userId_key: id };

  const claim = randomUUID();

  const claimed = await withTenant(services.db, actor.organisationId, async (tx) => {
    const now = services.now();
    const existing = await tx.idempotencyKey.findUnique({ where });
    if (existing) {
      const age = now.getTime() - existing.createdAt.getTime();
      const expired = age >= IDEMPOTENCY_TTL_MS;
      // The first attempt died before its write committed (it would have marked the key).
      const abandoned =
        existing.statusCode === null &&
        !existing.writeCommitted &&
        existing.requestHash === requestHash &&
        age >= ABANDONED_AFTER_MS;
      if (!expired && !abandoned) return existing;
      // Take the key over only if it is as we read it: a concurrent retry, or the first
      // attempt's write committing, wins instead.
      const { count } = await tx.idempotencyKey.updateMany({
        where: {
          ...id,
          claim: existing.claim,
          writeCommitted: existing.writeCommitted,
          statusCode: existing.statusCode,
        },
        data: {
          method: request.method,
          path,
          requestHash,
          claim,
          writeCommitted: false,
          statusCode: null,
          response: Prisma.DbNull,
          createdAt: now,
        },
      });
      return count === 1 ? null : await tx.idempotencyKey.findUnique({ where });
    }
    // Two first attempts at once: the primary key lets only one claim the key.
    const inserted = await tx.$executeRaw`
      INSERT INTO idempotency_keys
        (organisation_id, user_id, key, method, path, request_hash, claim, created_at)
      VALUES (${id.organisationId}::uuid, ${id.userId}::uuid, ${key}, ${request.method},
              ${path}, ${requestHash}, ${claim}::uuid, ${now})
      ON CONFLICT DO NOTHING`;
    return inserted === 1 ? null : await tx.idempotencyKey.findUnique({ where });
  });

  if (claimed) {
    if (claimed.requestHash !== requestHash) {
      throw new AppError(
        409,
        'CONFLICT',
        'This Idempotency-Key was already used for a different request.',
        { idempotencyKey: 'reused' },
      );
    }
    if (claimed.statusCode === null && claimed.writeCommitted) {
      throw new AppError(
        409,
        'CONFLICT',
        'The first request with this key made its change but its response was lost. Check the result before trying again with a new key.',
        { idempotencyKey: 'unknown' },
      );
    }
    if (claimed.statusCode === null) {
      throw new AppError(409, 'CONFLICT', 'The first request with this key is still running.', {
        idempotencyKey: 'in_progress',
      });
    }
    reply.header('idempotent-replay', 'true');
    return send(reply, { status: claimed.statusCode, body: claimed.response });
  }

  // Every transaction of the write that changes data marks the key in that same
  // transaction, and only while this attempt still holds it; otherwise it rolls back.
  const markWritten = async (tx: Tx, organisationId: string) => {
    if (organisationId !== id.organisationId) return;
    const [state] = await tx.$queryRaw<{ wrote: boolean }[]>`
      SELECT pg_current_xact_id_if_assigned() IS NOT NULL AS wrote`;
    if (!state?.wrote) return;
    const held = await tx.$executeRaw`
      UPDATE idempotency_keys SET write_committed = true
      WHERE organisation_id = ${id.organisationId}::uuid AND user_id = ${id.userId}::uuid
        AND key = ${key} AND claim = ${claim}::uuid`;
    if (held !== 1) {
      throw new AppError(409, 'CONFLICT', 'Another request with this key took over.', {
        idempotencyKey: 'in_progress',
      });
    }
  };

  let result: WriteResult;
  try {
    result = await afterTenantWork.run(markWritten, write);
  } catch (error) {
    // Nothing was written, so the client can correct and retry under the same key.
    await withTenant(services.db, actor.organisationId, (tx) =>
      tx.idempotencyKey.deleteMany({ where: { ...id, claim, writeCommitted: false } }),
    );
    throw error;
  }
  const store = () =>
    withTenant(services.db, actor.organisationId, (tx) =>
      tx.idempotencyKey.updateMany({
        where: { ...id, claim },
        data: { statusCode: result.status, response: result.body as Prisma.InputJsonValue },
      }),
    );
  // The write has happened: answer it even if the response cannot be kept, and a retry
  // is told the outcome is unknown rather than running the write again.
  await store()
    .catch(store)
    .catch((err: unknown) => request.log.error({ err }, 'Could not store the idempotent response'));
  return send(reply, result);
}

/**
 * Deletes keys older than the 24 hours they are replayed for, so stored responses are
 * not kept longer than that. Runs with the no-show sweep, once per organisation.
 */
export async function purgeExpiredIdempotencyKeys(
  s: Pick<Services, 'db' | 'now'>,
): Promise<number> {
  const cutoff = new Date(s.now().getTime() - IDEMPOTENCY_TTL_MS);
  const organisations = await withAuth(s.db, (tx) =>
    tx.organisation.findMany({ select: { id: true } }),
  );
  let total = 0;
  for (const { id } of organisations) {
    const { count } = await withTenant(s.db, id, (tx) =>
      tx.idempotencyKey.deleteMany({ where: { createdAt: { lte: cutoff } } }),
    );
    total += count;
  }
  return total;
}

const send = (reply: FastifyReply, { status, body }: WriteResult) =>
  body === undefined ? reply.status(status).send() : reply.status(status).send(body);
