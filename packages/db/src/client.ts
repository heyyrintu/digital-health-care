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

/**
 * Runs `fn` as the `dhc_platform` role (platform console, ADR 0016): platform operators,
 * their sessions and platform-level audit inserts. It has no grant on any tenant table;
 * what it may know about organisations comes only from the `platform_*` functions, which
 * return names, counts and doctors' registration details, never patient or clinical rows.
 */
export async function withPlatform<T>(
  db: Db,
  fn: (tx: Tx) => Promise<T>,
  /**
   * Prisma's interactive transaction limits, for callers that must give up quickly (system
   * health): `maxWait` for a connection, `timeout` for the whole transaction, after which it
   * is rolled back and its connection returned to the pool. Omitted, Prisma's defaults.
   */
  options?: { maxWait: number; timeout: number },
): Promise<T> {
  const run = async (tx: Tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE dhc_platform');
    return fn(tx);
  };
  return options ? db.$transaction(run, options) : db.$transaction(run);
}

/**
 * Onboarding (PRD §9.1 steps 1–2) in one transaction: creates the organisation as
 * `dhc_platform` (through `platform_create_organisation`), then runs `fn` as `dhc_app`
 * inside the new organisation, exactly as `withTenant` would. Returns null, changing
 * nothing, when the slug is taken.
 */
export async function withNewOrganisation<T>(
  db: Db,
  organisation: { slug: string; name: string; now: Date },
  fn: (tx: Tx, organisationId: string) => Promise<T>,
): Promise<T | null> {
  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE dhc_platform');
    const [row] = await tx.$queryRaw<{ id: string | null }[]>`
      SELECT platform_create_organisation(${organisation.slug}, ${organisation.name},
                                          ${organisation.now}) AS id`;
    if (!row?.id) return null;
    await tx.$executeRawUnsafe('SET LOCAL ROLE dhc_app');
    await tx.$executeRaw`SELECT set_config('app.organisation_id', ${row.id}, true)`;
    return fn(tx, row.id);
  });
}
