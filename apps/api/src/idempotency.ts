import { withTenant, type Prisma } from '@dhc/db';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { AppError } from './errors';
import { authOf } from './plugins/authenticate';
import type { Services } from './services';

/** How long a key's first result is replayed (API guide §2). */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const KEY = /^[A-Za-z0-9_-]{8,100}$/;

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
 * The key is claimed before the write and the result stored after it, each in its own
 * short transaction; a write that fails releases the key so the client can retry.
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

  const claimed = await withTenant(services.db, actor.organisationId, async (tx) => {
    const now = services.now();
    const existing = await tx.idempotencyKey.findUnique({ where });
    if (existing && existing.createdAt.getTime() > now.getTime() - IDEMPOTENCY_TTL_MS) {
      return existing;
    }
    if (existing) await tx.idempotencyKey.delete({ where });
    // Two first attempts at once: the primary key lets only one claim the key.
    const inserted = await tx.$executeRaw`
      INSERT INTO idempotency_keys
        (organisation_id, user_id, key, method, path, request_hash, created_at)
      VALUES (${id.organisationId}::uuid, ${id.userId}::uuid, ${key}, ${request.method},
              ${path}, ${requestHash}, ${now})
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
    if (claimed.statusCode === null) {
      throw new AppError(409, 'CONFLICT', 'The first request with this key is still running.', {
        idempotencyKey: 'in_progress',
      });
    }
    reply.header('idempotent-replay', 'true');
    return send(reply, { status: claimed.statusCode, body: claimed.response });
  }

  let result: WriteResult;
  try {
    result = await write();
  } catch (error) {
    await withTenant(services.db, actor.organisationId, (tx) =>
      tx.idempotencyKey.deleteMany({ where: { ...id, statusCode: null } }),
    );
    throw error;
  }
  await withTenant(services.db, actor.organisationId, (tx) =>
    tx.idempotencyKey.update({
      where,
      data: { statusCode: result.status, response: result.body as Prisma.InputJsonValue },
    }),
  );
  return send(reply, result);
}

const send = (reply: FastifyReply, { status, body }: WriteResult) =>
  body === undefined ? reply.status(status).send() : reply.status(status).send(body);
