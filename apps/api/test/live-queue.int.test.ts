/**
 * Live queue: server-sent events from database changes (build plan: SSE instead of
 * polling). Runs against a listening server, since a stream never "finishes".
 */
import { CreatedDisplayScreen, type TokenResponse } from '@dhc/contracts';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sweepNoShows } from '../src/modules/appointments/no-shows';
import { bearer, createHarness, resetDatabase, seedTwoClinics, staffLogin } from './harness';

const TODAY = '2026-10-06';
const h = createHarness();
let base: string;
let clinics: Awaited<ReturnType<typeof seedTwoClinics>>;
let doctorA: TokenResponse;
let clinicA: string;
let clinicB: string;
let type: string;
let typeB: string;

beforeAll(async () => {
  await h.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(h.app.server.address() as AddressInfo).port}/v1`;
});

beforeEach(async () => {
  h.clock.ms = Date.UTC(2026, 9, 6, 4, 30);
  await resetDatabase(h.owner);
  clinics = await seedTwoClinics(h);
  doctorA = await staffLogin(h, 'clinic-a', clinics.a.doctor);
  const place = (organisationId: string) =>
    h.owner.clinic.create({ data: { organisationId, name: 'Main clinic' } });
  const kind = (organisationId: string) =>
    h.owner.consultationType.create({
      data: {
        organisationId,
        name: 'Visit',
        mode: 'in_person',
        defaultDurationMin: 15,
        feePaise: 0,
      },
    });
  clinicA = (await place(clinics.a.org.id)).id;
  clinicB = (await place(clinics.b.org.id)).id;
  type = (await kind(clinics.a.org.id)).id;
  typeB = (await kind(clinics.b.org.id)).id;
});

afterAll(async () => {
  await h.app.close();
  await h.owner.$disconnect();
});

let token = 0;
async function visitIn(org: 'a' | 'b', date = TODAY) {
  const c = clinics[org];
  const startAt = new Date(`${date}T04:30:00.000Z`);
  token += 1;
  return h.owner.appointment.create({
    data: {
      organisationId: c.org.id,
      patientId: c.patients[0]!.id,
      doctorUserId: c.doctor.userId,
      clinicId: org === 'a' ? clinicA : clinicB,
      consultationTypeId: org === 'a' ? type : typeB,
      date: new Date(`${date}T00:00:00.000Z`),
      startAt,
      endAt: new Date(startAt.getTime() + 15 * 60_000),
      status: 'confirmed',
      source: 'front_desk',
      tokenNumber: token,
      createdByUserId: c.doctor.userId,
    },
  });
}

/** Opens a stream and returns a reader of its events. */
async function open(path: string, init: RequestInit) {
  const controller = new AbortController();
  const res = await fetch(`${base}${path}`, { ...init, signal: controller.signal });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let ended = false;
  const next = async (ms = 3000): Promise<{ event: string; data: unknown } | null> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const end = buffer.indexOf('\n\n');
      if (end >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (block.startsWith(':')) continue;
        const event = /^event: (.*)$/m.exec(block)?.[1] ?? 'message';
        const data = JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? 'null');
        return { event, data };
      }
      const left = deadline - Date.now();
      if (left <= 0) return null;
      const chunk = await Promise.race([
        reader.read(),
        new Promise<null>((r) => setTimeout(() => r(null), left)),
      ]);
      if (chunk?.done) ended = true;
      if (!chunk || chunk.done) return null;
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  };
  return { next, ended: () => ended, close: () => controller.abort() };
}

describe('live queue stream', () => {
  it('tells a clinic’s staff which visit changed today, and nothing from other clinics', async () => {
    const stream = await open('/queue/stream', { headers: bearer(doctorA) });
    expect(await stream.next()).toEqual({ event: 'ready', data: { date: TODAY } });

    await visitIn('b');
    await visitIn('a', '2026-10-07');
    const visit = await visitIn('a');
    expect(await stream.next()).toEqual({ event: 'queue', data: { appointmentId: visit.id } });

    await h.owner.appointment.update({ where: { id: visit.id }, data: { status: 'checked_in' } });
    expect(await stream.next()).toEqual({ event: 'queue', data: { appointmentId: visit.id } });
    expect(await stream.next(500)).toBeNull();
    stream.close();
  });

  it('pushes automatic no-shows from the sweep, once', async () => {
    const visit = await visitIn('a');
    const stream = await open('/queue/stream', { headers: bearer(doctorA) });
    expect(await stream.next()).toEqual({ event: 'ready', data: { date: TODAY } });

    // 10:00–10:15 IST slot with the default 30 minutes' grace: due at 10:45.
    h.clock.ms = Date.UTC(2026, 9, 6, 5, 15);
    const source = { id: 'sweep-test', ip: 'scheduler', headers: { 'user-agent': 'sweep' } };
    expect(await sweepNoShows(h.services, source)).toBe(1);
    // The status change reaches the stream through the database trigger, and only once.
    expect(await stream.next()).toEqual({ event: 'queue', data: { appointmentId: visit.id } });
    expect(await stream.next(500)).toBeNull();
    stream.close();
  });

  it('needs a staff sign-in', async () => {
    const res = await fetch(`${base}/queue/stream`);
    expect(res.status).toBe(401);
  });

  it('streams to a waiting-room screen by its token, until the token is revoked', async () => {
    const admin = await staffLogin(h, 'clinic-a', clinics.a.admin);
    const created = await h.app.inject({
      method: 'POST',
      url: '/v1/display-screens',
      headers: bearer(admin),
      payload: { clinicId: clinicA, label: 'Reception TV' },
    });
    const screen = CreatedDisplayScreen.parse(created.json());
    const body = JSON.stringify({ token: screen.link.split('#')[1] });
    const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body };

    const stream = await open('/display/stream', init);
    expect((await stream.next())?.event).toBe('ready');
    const visit = await visitIn('a');
    expect(await stream.next()).toEqual({ event: 'queue', data: { appointmentId: visit.id } });

    await h.app.inject({
      method: 'POST',
      url: `/v1/display-screens/${screen.id}/revoke`,
      headers: bearer(admin),
    });
    // The open stream hears nothing more once the screen is revoked, and is closed.
    await visitIn('a');
    expect(await stream.next()).toBeNull();
    expect(stream.ended()).toBe(true);
    stream.close();

    const refused = await fetch(`${base}/display/stream`, init);
    expect(refused.status).toBeGreaterThanOrEqual(400);
  });
});
