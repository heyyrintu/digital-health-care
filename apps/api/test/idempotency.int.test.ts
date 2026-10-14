/**
 * Idempotency-Key (API guide §2): a retried write returns the first result instead of
 * running again.
 */
import { PriceList, type TokenResponse } from '@dhc/contracts';
import { createHash } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addStaff,
  bearer,
  createHarness,
  resetDatabase,
  seedTwoClinics,
  staffLogin,
} from './harness';

const h = createHarness();
let clinics: Awaited<ReturnType<typeof seedTwoClinics>>;
let admin: TokenResponse;
let otherAdmin: TokenResponse;

beforeEach(async () => {
  h.clock.ms = Date.UTC(2026, 9, 6, 4, 30);
  await resetDatabase(h.owner);
  clinics = await seedTwoClinics(h);
  const second = await addStaff(h, clinics.a.org.id, 'clinic_admin', 'admin2@clinic-a.test');
  admin = await staffLogin(h, 'clinic-a', clinics.a.admin);
  otherAdmin = await staffLogin(h, 'clinic-a', second);
});

afterAll(async () => {
  await h.app.close();
  await h.owner.$disconnect();
});

const addItem = (body: object, key?: string, tokens = admin) =>
  h.app.inject({
    method: 'POST',
    url: '/v1/price-list',
    headers: { ...bearer(tokens), ...(key ? { 'idempotency-key': key } : {}) },
    payload: body,
  });
const items = async () =>
  PriceList.parse(
    (await h.app.inject({ method: 'GET', url: '/v1/price-list', headers: bearer(admin) })).json(),
  ).data;

const DRESSING = { name: 'Dressing', pricePaise: 15000 };

describe('Idempotency-Key', () => {
  it('replays the first response for a retry with the same key and body', async () => {
    const first = await addItem(DRESSING, 'key-dressing-1');
    expect(first.statusCode, first.body).toBe(201);
    expect(first.headers['idempotent-replay']).toBeUndefined();

    const retry = await addItem(DRESSING, 'key-dressing-1');
    expect(retry.statusCode).toBe(201);
    expect(retry.headers['idempotent-replay']).toBe('true');
    expect(retry.json()).toEqual(first.json());
    expect(await items()).toHaveLength(1);
  });

  it('refuses the same key with a different body, and badly formed keys', async () => {
    await addItem(DRESSING, 'key-dressing-2');
    const changed = await addItem({ name: 'Injection', pricePaise: 5000 }, 'key-dressing-2');
    expect(changed.statusCode).toBe(409);
    expect(changed.json().error.fields).toEqual({ idempotencyKey: 'reused' });

    const bad = await addItem({ name: 'Injection', pricePaise: 5000 }, 'short');
    expect(bad.statusCode).toBe(400);
    expect(await items()).toHaveLength(1);
  });

  it('refuses a retry while the first request is still running', async () => {
    // A claimed key with no stored result yet: the first request is mid-flight.
    await h.owner.idempotencyKey.create({
      data: {
        organisationId: clinics.a.org.id,
        userId: clinics.a.admin.userId,
        key: 'key-in-flight',
        method: 'POST',
        path: '/v1/price-list',
        requestHash: createHash('sha256')
          .update(`POST /v1/price-list\n${JSON.stringify(DRESSING)}`)
          .digest('hex'),
        createdAt: new Date(h.clock.ms),
      },
    });
    const res = await addItem(DRESSING, 'key-in-flight');
    expect(res.statusCode).toBe(409);
    expect(res.json().error.fields).toEqual({ idempotencyKey: 'in_progress' });
    expect(await items()).toEqual([]);
  });

  it('keeps keys per person, releases a key whose write failed, and forgets after 24 h', async () => {
    await addItem(DRESSING, 'key-shared-1');
    // Another admin's identical key is their own: it runs, and hits the duplicate name.
    const other = await addItem(DRESSING, 'key-shared-1', otherAdmin);
    expect(other.statusCode).toBe(409);
    expect(other.headers['idempotent-replay']).toBeUndefined();
    // That failure released the key, so a corrected retry under it runs.
    const fixed = await addItem(
      { name: 'Dressing (large)', pricePaise: 25000 },
      'key-shared-1',
      otherAdmin,
    );
    expect(fixed.statusCode, fixed.body).toBe(201);

    h.clock.advance(24 * 60 * 60 + 1);
    admin = await staffLogin(h, 'clinic-a', clinics.a.admin);
    const later = await addItem({ name: 'Plaster', pricePaise: 4000 }, 'key-shared-1');
    expect(later.statusCode, later.body).toBe(201);
    expect((await items()).map((i) => i.name).sort()).toEqual([
      'Dressing',
      'Dressing (large)',
      'Plaster',
    ]);
  });

  it('runs normally without the header', async () => {
    expect((await addItem(DRESSING)).statusCode).toBe(201);
    expect((await addItem(DRESSING)).statusCode).toBe(409);
  });
});
