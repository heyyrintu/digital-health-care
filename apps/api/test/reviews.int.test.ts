import { randomUUID } from 'node:crypto';
import { beforeEach, afterAll, it, expect } from 'vitest';
import { withMessaging, withTenant, withPlatform } from '@dhc/db';
import { createReviewLinkToken } from '@dhc/secure-links';
import {
  createHarness,
  resetDatabase,
  seedTwoClinics,
  staffLogin,
  patientLogin,
  bearer,
} from './harness';
import type { TokenResponse } from '@dhc/contracts';
const h = createHarness(),
  secret = 'synthetic-review-secret-at-least-32-characters';
let clinics: Awaited<ReturnType<typeof seedTwoClinics>>,
  admin: TokenResponse,
  doctor: TokenResponse,
  other: TokenResponse,
  patient: TokenResponse,
  patientId: string,
  visit: string,
  place: string,
  type: string;
const call = (method: string, path: string, body?: object, token = admin) =>
  h.app.inject({
    method: method as 'GET',
    url: '/v1' + path,
    payload: body,
    headers: bearer(token),
  });
const settings = async (patch: object = {}) => {
  const current = (await call('GET', '/review-settings')).json();
  return call('PUT', '/review-settings', {
    version: current.version,
    enabled: true,
    googleUrl: 'https://g.page/r/SyntheticClinic/review',
    cooldownDays: 90,
    ...patch,
  });
};
const agree = () =>
  call('PUT', '/portal/review-consent', { enabled: true, recipientAgreed: true }, patient);
const request = (id = randomUUID(), appointmentId = visit) =>
  call('POST', '/review-requests', { id, appointmentId });
async function newVisit(p = patientId, status = 'completed', days = 1) {
  const start = new Date(Date.now() - days * 86400000);
  return (
    await h.owner.appointment.create({
      data: {
        organisationId: clinics.a.org.id,
        patientId: p,
        doctorUserId: clinics.a.doctor.userId,
        clinicId: place,
        consultationTypeId: type,
        date: new Date(start.toISOString().slice(0, 10)),
        startAt: start,
        endAt: new Date(start.getTime() + 900000),
        status: status as 'completed',
        source: 'front_desk',
        tokenNumber: Math.floor(Math.random() * 1000000) + 1,
        createdByUserId: clinics.a.admin.userId,
      },
    })
  ).id;
}
const begin = (id: string) =>
  withMessaging(
    h.services.db,
    (tx) =>
      tx.$queryRaw<
        { phone: string; clinic_name: string; expires_at: Date }[]
      >`SELECT * FROM messaging_begin_review_notice(${id}::uuid,${'1234'})`,
  );
const finish = (
  id: string,
  status = 'accepted',
  message: string | null = 'synthetic-provider-message',
) =>
  withMessaging(
    h.services.db,
    (tx) =>
      tx.$executeRaw`SELECT messaging_finish_review_notice(${id}::uuid,${'1234'},${status},${message})`,
  );
async function queued() {
  expect((await agree()).statusCode).toBe(200);
  const r = await request();
  expect(r.statusCode, r.body).toBe(201);
  return r.json();
}
async function token(id: string) {
  const r = await h.owner.reviewRequest.findUniqueOrThrow({ where: { id } });
  return createReviewLinkToken(r.id, r.expiresAt, secret);
}
beforeEach(async () => {
  await resetDatabase(h.owner);
  h.clock.ms = Date.now() - 60000;
  clinics = await seedTwoClinics(h);
  h.services.reviewMessagingSender = '1234';
  h.services.reviewLinkSecret = secret;
  admin = await staffLogin(h, 'clinic-a', clinics.a.admin);
  doctor = await staffLogin(h, 'clinic-a', clinics.a.doctor);
  other = await staffLogin(h, 'clinic-b', clinics.b.admin);
  patientId = clinics.a.patients[0]!.id;
  await h.owner.patient.update({ where: { id: patientId }, data: { phone: '+919876543210' } });
  patient = await patientLogin(h, 'clinic-a', '9876543210');
  place = (
    await h.owner.clinic.create({
      data: { organisationId: clinics.a.org.id, name: 'Synthetic clinic' },
    })
  ).id;
  type = (
    await h.owner.consultationType.create({
      data: {
        organisationId: clinics.a.org.id,
        name: 'Visit',
        mode: 'in_person',
        defaultDurationMin: 15,
        feePaise: 0,
      },
    })
  ).id;
  visit = await newVisit();
  expect((await settings()).statusCode).toBe(200);
});
afterAll(async () => {
  await h.app.close();
  await h.owner.$disconnect();
});
it('allows only admin configuration, enforces version checks and rejects untrusted destinations', async () => {
  expect((await call('GET', '/review-settings', undefined, doctor)).statusCode).toBe(403);
  expect(
    (
      await call('PUT', '/review-settings', {
        version: 0,
        enabled: true,
        googleUrl: 'https://evil.test',
        cooldownDays: 90,
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await call('PUT', '/review-settings', {
        version: 0,
        enabled: true,
        googleUrl: 'https://g.page/r/SyntheticClinic/review',
        cooldownDays: 90,
      })
    ).statusCode,
  ).toBe(409);
  expect((await call('GET', '/review-requests', undefined, patient)).statusCode).toBe(403);
});
it('requires separate number-holder consent and recent completed visits', async () => {
  expect((await request()).statusCode).toBe(409);
  expect((await call('PUT', '/portal/review-consent', { enabled: true }, patient)).statusCode).toBe(
    400,
  );
  await agree();
  expect((await request(randomUUID(), await newVisit(patientId, 'confirmed'))).statusCode).toBe(
    409,
  );
  expect((await request(randomUUID(), await newVisit(patientId, 'completed', 31))).statusCode).toBe(
    409,
  );
  expect((await request()).statusCode).toBe(201);
});
it('serializes same-ID retries and enforces cooldown across family profiles, cancellations and failures', async () => {
  await agree();
  const id = randomUUID(),
    r = await Promise.all([request(id), request(id)]);
  expect(r.map((x) => x.statusCode)).toEqual([201, 201]);
  expect(await h.owner.reviewRequest.count()).toBe(1);
  const child = await h.owner.patient.create({
    data: {
      organisationId: clinics.a.org.id,
      uhid: 'REVIEW-CHILD',
      name: 'Synthetic child',
      guardianPatientId: patientId,
    },
  });
  expect((await request(randomUUID(), await newVisit(child.id))).statusCode).toBe(409);
  await call('POST', `/review-requests/${id}/cancel`);
  expect((await request(randomUUID(), await newVisit())).statusCode).toBe(409);
});
it('separates clinics, exposes no platform table access and retains request identity', async () => {
  const r = await queued();
  expect((await call('POST', `/review-requests/${r.id}/cancel`, {}, other)).statusCode).toBe(404);
  expect((await call('GET', '/review-requests', undefined, other)).json().data).toEqual([]);
  expect(await withTenant(h.services.db, clinics.b.org.id, (tx) => tx.reviewRequest.count())).toBe(
    0,
  );
  await expect(withPlatform(h.services.db, (tx) => tx.reviewRequest.count())).rejects.toThrow();
  await expect(
    h.owner.reviewRequest.update({
      where: { id: r.id },
      data: { destinationUrl: 'https://evil.test' },
    }),
  ).rejects.toThrow(/immutable/);
});
it('rechecks consent and cancellations at dispatch, authorizes at most one send', async () => {
  const r = await queued();
  const first = await begin(r.id);
  expect(first).toHaveLength(1);
  expect(first[0]!.phone).toBe('+919876543210');
  expect(await begin(r.id)).toHaveLength(0);
  await finish(r.id);
  expect(await begin(r.id)).toHaveLength(0);
  const data = (await call('GET', '/review-requests')).json();
  expect(data.data[0].status).toBe('accepted');
  expect(data.metrics.accepted).toBe(1);
});
it('STOP revokes only optional messaging and blocks queued sends and live links', async () => {
  const r = await queued();
  const t = await token(r.id);
  await begin(r.id);
  await finish(r.id);
  expect((await call('POST', '/review-links/resolve', { token: t })).statusCode).toBe(200);
  await withMessaging(
    h.services.db,
    (tx) =>
      tx.$executeRaw`SELECT messaging_opt_out_phone(${'a'.repeat(64)},${'1234'},${'+919876543210'},${new Date(Date.now() + 60000)})`,
  );
  expect((await call('POST', '/review-links/open', { token: t })).statusCode).toBe(404);
  expect((await call('GET', '/portal/review-consent', undefined, patient)).json().enabled).toBe(
    false,
  );
  expect((await call('GET', '/me', undefined, patient)).statusCode).toBe(200);
});
it('counts a deliberate link open once, never counts resolution, and rejects expired/tampered links', async () => {
  const r = await queued(),
    t = await token(r.id);
  expect((await call('POST', '/review-links/resolve', { token: t })).statusCode).toBe(404);
  await begin(r.id);
  await finish(r.id);
  const resolve = await call('POST', '/review-links/resolve', { token: t });
  expect(resolve.statusCode, resolve.body).toBe(200);
  expect(resolve.json()).toEqual({ clinicName: clinics.a.org.name });
  expect(
    (await h.owner.reviewRequest.findUniqueOrThrow({ where: { id: r.id } })).openedAt,
  ).toBeNull();
  const opened = await Promise.all([
    call('POST', '/review-links/open', { token: t }),
    call('POST', '/review-links/open', { token: t }),
  ]);
  expect(opened.map((x) => x.statusCode)).toEqual([200, 200]);
  expect(opened[0].json()).toEqual({ url: 'https://g.page/r/SyntheticClinic/review' });
  expect(
    await h.owner.auditLog.count({ where: { action: 'review.link_opened', entityId: r.id } }),
  ).toBe(1);
  expect((await call('POST', '/review-links/open', { token: t + 'a' })).statusCode).toBe(404);
  h.clock.advance(15 * 86400);
  expect((await call('POST', '/review-links/open', { token: t })).statusCode).toBe(404);
});
it('blocks revoked consent before dispatch and settings changes after dispatch', async () => {
  const r = await queued();
  await call('PUT', '/portal/review-consent', { enabled: false }, patient);
  expect(await begin(r.id)).toHaveLength(0);
  const delivery = await h.owner.whatsAppDelivery.findUniqueOrThrow({ where: { id: r.id } });
  expect(delivery.status).toBe('skipped');
});
it('does not resend after an uncertain send and preserves stronger early delivery callbacks', async () => {
  const r = await queued();
  await begin(r.id);
  await finish(r.id, 'uncertain', null);
  expect(await begin(r.id)).toHaveLength(0);
  await withMessaging(h.services.db, async (tx) => {
    const event = randomUUID();
    await tx.$queryRaw`SELECT messaging_receive_status(${event}::uuid,${'1234'},${'early-message'},${r.id}::uuid,${'read'},${new Date()},${null}::integer)`;
    await tx.$executeRaw`SELECT messaging_process_status(${event}::uuid)`;
  });
  await finish(r.id, 'accepted', 'early-message');
  expect((await h.owner.whatsAppDelivery.findUniqueOrThrow({ where: { id: r.id } })).status).toBe(
    'read',
  );
});
it('invalidates pending and accepted invitations after a settings revision or cancellation', async () => {
  const r = await queued(),
    t = await token(r.id);
  await begin(r.id);
  await finish(r.id);
  await settings({ cooldownDays: 100 });
  expect((await call('POST', '/review-links/open', { token: t })).statusCode).toBe(404);
  await call('POST', `/review-requests/${r.id}/cancel`);
  expect(
    (await h.owner.reviewRequest.findUniqueOrThrow({ where: { id: r.id } })).cancelledAt,
  ).not.toBeNull();
});

it('serializes different request IDs for one recipient and never bypasses consent after phone/account changes', async () => {
  await agree();
  const second = await newVisit();
  const results = await Promise.all([request(), request(randomUUID(), second)]);
  expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
  expect(await h.owner.reviewRequest.count()).toBe(1);
  const r = await h.owner.reviewRequest.findFirstOrThrow();
  await h.owner.user.updateMany({
    where: { phone: '+919876543210' },
    data: { status: 'disabled' },
  });
  expect(await begin(r.id)).toHaveLength(0);
});
it('rechecks settings before dispatch', async () => {
  const r = await queued();
  await settings({ enabled: false });
  expect(await begin(r.id)).toHaveLength(0);
  expect((await h.owner.whatsAppDelivery.findUniqueOrThrow({ where: { id: r.id } })).status).toBe(
    'skipped',
  );
});
it('blocks links after portal closure', async () => {
  const r = await queued(),
    t = await token(r.id);
  await begin(r.id);
  await finish(r.id);
  await h.owner.patient.update({ where: { id: patientId }, data: { portalClosedAt: new Date() } });
  expect((await call('POST', '/review-links/resolve', { token: t })).statusCode).toBe(404);
});
it('blocks a queued send if the completed visit is cancelled', async () => {
  const r = await queued();
  await h.owner.appointment.update({ where: { id: visit }, data: { status: 'cancelled' } });
  expect(await begin(r.id)).toHaveLength(0);
});
it('allows revocation after health-data withdrawal and does not grant consent to staff', async () => {
  expect(
    (await call('PUT', '/portal/review-consent', { enabled: true, recipientAgreed: true }))
      .statusCode,
  ).toBe(403);
  await agree();
  expect(
    (await call('PUT', '/portal/review-consent', { enabled: false }, patient)).statusCode,
  ).toBe(200);
});
