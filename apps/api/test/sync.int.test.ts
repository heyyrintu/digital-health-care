import { SyncMedicinesResponse, SyncTodayResponse, type TokenResponse } from '@dhc/contracts';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addStaff,
  bearer,
  createHarness,
  resetDatabase,
  seedTwoClinics,
  staffLogin,
} from './harness';

const TODAY = '2026-10-06';
const at = (date: string, time: string) =>
  new Date(new Date(`${date}T${time}:00.000Z`).getTime() - 330 * 60_000).toISOString();

const h = createHarness();
let clinics: Awaited<ReturnType<typeof seedTwoClinics>>;
let adminA: TokenResponse;
let doctorA: TokenResponse;
let deskA: TokenResponse;
let doctorB: TokenResponse;

beforeEach(async () => {
  h.clock.ms = Date.UTC(2026, 9, 6, 4, 30);
  await resetDatabase(h.owner);
  clinics = await seedTwoClinics(h);
  const desk = await addStaff(h, clinics.a.org.id, 'front_desk', 'desk@clinic-a.test');
  adminA = await staffLogin(h, 'clinic-a', clinics.a.admin);
  doctorA = await staffLogin(h, 'clinic-a', clinics.a.doctor);
  deskA = await staffLogin(h, 'clinic-a', desk);
  doctorB = await staffLogin(h, 'clinic-b', clinics.b.doctor);
});

afterAll(async () => {
  await h.app.close();
  await h.owner.$disconnect();
});

const call = (url: string, tokens: TokenResponse) =>
  h.app.inject({ method: 'GET', url: `/v1${url}`, headers: bearer(tokens) });

async function medicines(tokens: TokenResponse, query = '') {
  const res = await call(`/sync/medicines${query}`, tokens);
  expect(res.statusCode, res.body).toBe(200);
  return SyncMedicinesResponse.parse(res.json());
}

/** A clinic medicine changed a minute ago, outside the settle window. */
async function clinicMedicine(organisationId: string, name: string, minutesAgo = 1) {
  return h.owner.medicine.create({
    data: {
      organisationId,
      name,
      genericName: name.toUpperCase(),
      composition: `${name} 500 mg`,
      form: 'tablet',
      source: 'clinic',
      updatedAt: new Date(Date.now() - minutesAgo * 60_000),
    },
  });
}

describe('medicine cache', () => {
  it('downloads every active medicine in pages, then only what changed', async () => {
    const reference = await h.owner.medicine.count({
      where: { organisationId: null, active: true },
    });
    await clinicMedicine(clinics.a.org.id, 'Synthocil', 3);
    await clinicMedicine(clinics.b.org.id, 'Otherclinicol', 3);

    // Page through the full download.
    let cursor: string | undefined;
    const names: string[] = [];
    for (;;) {
      const page = await medicines(doctorA, `?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      names.push(...page.data.map((m) => m.name));
      cursor = page.cursor!;
      if (!page.hasMore) break;
    }
    expect(names).toContain('Synthocil');
    expect(names).not.toContain('Otherclinicol');
    expect(names).toHaveLength(reference + 1);

    // Nothing changed: the same cursor comes back with no rows.
    const idle = await medicines(doctorA, `?cursor=${cursor}`);
    expect(idle).toMatchObject({ data: [], cursor, hasMore: false });

    // A deactivated medicine and a new one come through; the inactive one says so.
    const synthocil = await h.owner.medicine.findFirstOrThrow({ where: { name: 'Synthocil' } });
    await h.owner.medicine.update({
      where: { id: synthocil.id },
      data: { active: false, updatedAt: new Date(Date.now() - 30_000) },
    });
    await clinicMedicine(clinics.a.org.id, 'Newmycin', 0.5);
    // Changed in the last few seconds: held back until the next round.
    await clinicMedicine(clinics.a.org.id, 'Justnowin', 0);
    const delta = await medicines(doctorA, `?cursor=${cursor}`);
    expect(delta.data.map((m) => [m.name, m.active])).toEqual([
      ['Synthocil', false],
      ['Newmycin', true],
    ]);
  });

  it('includes the names the clinic admin linked, and refuses bad cursors and other roles', async () => {
    const med = await clinicMedicine(clinics.a.org.id, 'Synthocil');
    await h.owner.medicineRequest.create({
      data: {
        organisationId: clinics.a.org.id,
        nameKey: 'synth 500',
        name: 'Synth 500',
        decision: 'approved',
        medicineId: med.id,
        decidedByUserId: clinics.a.admin.userId,
      },
    });
    expect((await medicines(doctorA)).aliases).toEqual([{ name: 'Synth 500', medicineId: med.id }]);
    expect((await medicines(doctorB)).aliases).toEqual([]);

    const bad = await call('/sync/medicines?cursor=bm90LWEtY3Vyc29y', doctorA);
    expect(bad.statusCode).toBe(400);
    expect((await call('/sync/medicines', deskA)).statusCode).toBe(403);
    expect((await call('/sync/medicines', adminA)).statusCode).toBe(403);
  });
});

describe('today snapshot', () => {
  it('gives a doctor their own queue and templates, and the front desk everyone', async () => {
    const clinicId = (
      await h.app.inject({
        method: 'POST',
        url: '/v1/clinics',
        headers: bearer(adminA),
        payload: { name: 'Main clinic' },
      })
    ).json().id;
    const typeId = (
      await h.app.inject({
        method: 'POST',
        url: '/v1/consultation-types',
        headers: bearer(adminA),
        payload: {
          name: 'In-person consultation',
          mode: 'in_person',
          defaultDurationMin: 15,
          feePaise: 80000,
        },
      })
    ).json().id;
    await h.app.inject({
      method: 'POST',
      url: '/v1/availability/versions',
      headers: bearer(doctorA),
      payload: {
        clinicId,
        consultationTypeId: typeId,
        effectiveFrom: TODAY,
        weekly: { tue: [{ start: '10:00', end: '12:00' }] },
      },
    });
    const booked = await h.app.inject({
      method: 'POST',
      url: '/v1/appointments',
      headers: bearer(deskA),
      payload: {
        patientId: clinics.a.patients[0]!.id,
        doctorUserId: clinics.a.doctor.userId,
        clinicId,
        consultationTypeId: typeId,
        startAt: at(TODAY, '11:00'),
      },
    });
    expect(booked.statusCode, booked.body).toBe(201);
    await h.owner.prescriptionTemplate.create({
      data: {
        organisationId: clinics.a.org.id,
        doctorUserId: clinics.a.doctor.userId,
        name: 'Viral fever',
        items: [],
      },
    });

    const mine = SyncTodayResponse.parse((await call('/sync/today', doctorA)).json());
    expect(mine.serverTime).toBe(new Date(h.clock.ms).toISOString());
    expect(mine.queue.date).toBe(TODAY);
    expect(mine.queue.booked.map((a) => a.patient.name)).toEqual(['Asha Verma']);
    expect(mine.templates.map((t) => t.name)).toEqual(['Viral fever']);

    const front = SyncTodayResponse.parse((await call('/sync/today', deskA)).json());
    expect(front.queue.booked).toHaveLength(1);
    expect(front.templates).toEqual([]);

    const other = SyncTodayResponse.parse((await call('/sync/today', doctorB)).json());
    expect(other.queue.booked).toEqual([]);
  });
});
