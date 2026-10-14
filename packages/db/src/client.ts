import { PrismaPg } from '@prisma/adapter-pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import { PrismaClient, type Prisma } from './generated/prisma/client.ts';

export type Db = PrismaClient;
export type Tx = Prisma.TransactionClient;

export function createDb(databaseUrl: string): Db {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Runs last inside every `withTenant` transaction started within `afterTenantWork.run`,
 * before it commits; throwing rolls that transaction back. Idempotency keys use it to
 * record, atomically with a write, that the write happened.
 */
export const afterTenantWork = new AsyncLocalStorage<
  (tx: Tx, organisationId: string) => Promise<void>
>();

/**
 * Runs `fn` as the `dhc_app` role with the organisation set for row-level security.
 * Every tenant-scoped query must go through here: inside it, other organisations' rows
 * do not exist, and writes that name another organisation are rejected by Postgres.
 */
export async function withTenant<T>(
  db: Db,
  organisationId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (!UUID.test(organisationId)) throw new Error('withTenant needs an organisation UUID');
  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE dhc_app');
    await tx.$executeRaw`SELECT set_config('app.organisation_id', ${organisationId}, true)`;
    const result = await fn(tx);
    await afterTenantWork.getStore()?.(tx, organisationId);
    return result;
  });
}

/**
 * Runs `fn` as the `dhc_auth` role: identity tables (users, sessions, OTP challenges),
 * organisation lookup, membership checks and audit inserts. No access to clinical data.
 */
export async function withAuth<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE dhc_auth');
    return fn(tx);
  });
}
