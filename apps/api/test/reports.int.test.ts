import {
  AuditListResponse,
  Bill,
  DashboardReport,
  Payment,
  type TokenResponse,
} from '@dhc/contracts';
import { randomUUID } from 'node:crypto';
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
let doctor: TokenResponse;
let desk: TokenResponse;
let adminB: TokenResponse;
let deskUserId: string;
let clinicId: string;
let typeId: string;

beforeEach(async () => {
  // 6 Oct 2026, 10:00 IST.
  h.clock.ms = Date.UTC(2026, 9, 6, 4, 30);
  await resetDatabase(h.owner);
  clinics = await seedTwoClinics(h);
  const frontDesk = await addStaff(h, clinics.a.org.id, 'front_desk', 'desk@clinic-a.test');
  deskUserId = frontDesk.userId;
  admin = await staffLogin(h, 'clinic-a', clinics.a.admin);
  doctor = await staffLogin(h, 'clinic-a', clinics.a.doctor);
  desk = await staffLogin(h, 'clinic-a', frontDesk);
  adminB = await staffLogin(h, 'clinic-b', clinics.b.admin);
  const org = clinics.a.org.id;
  clinicId = (await h.owner.clinic.create({ data: { organisationId: org, name: 'Main clinic' } }))
    .id;
  typeId = (
    await h.owner.consultationType.create({
      data: {
        organisationId: org,
        name: 'In-person consultation',
        mode: 'in_person',
        defaultDurationMin: 15,
        feePaise: 80000,
      },
    })
  ).id;
});

afterAll(async () => {
  await h.app.close();
  await h.owner.$disconnect();
});

const call = (method: string, url: string, tokens: TokenResponse | null, payload?: unknown) =>
  h.app.inject({
    method: method as 'GET',
    url: `/v1${url}`,
    headers: tokens ? bearer(tokens) : {},
    payload: payload as object,
  });

let token = 0;
/** A clinic A visit on an IST day, straight into the database. */
async function visit(
  date: string,
  status: 'confirmed' | 'completed' | 'cancelled' | 'no_show' | 'rescheduled',
  patient = 0,
) {
  const startAt = new Date(`${date}T04:30:00.000Z`);
  token += 1;
  const row = await h.owner.appointment.create({
    data: {
      organisationId: clinics.a.org.id,
      patientId: clinics.a.patients[patient]!.id,
      doctorUserId: clinics.a.doctor.userId,
      clinicId,
      consultationTypeId: typeId,
      date: new Date(`${date}T00:00:00.000Z`),
      startAt,
      endAt: new Date(startAt.getTime() + 15 * 60_000),
      status,
      source: 'front_desk',
      tokenNumber: token,
      createdByUserId: clinics.a.doctor.userId,
    },
  });
  return row.id;
}

/** A signed (first version) prescription on a visit, with the fields the database requires. */
async function signedPrescription(
  appointmentId: string,
  signedAt: string,
  { voided = false, patient = 0 } = {},
) {
  await h.owner.prescription.create({
    data: {
      organisationId: clinics.a.org.id,
      appointmentId,
      patientId: clinics.a.patients[patient]!.id,
      doctorUserId: clinics.a.doctor.userId,
      status: voided ? 'void' : 'signed',
      number: `RX-${randomUUID().slice(0, 8)}`,
      signedAt: new Date(signedAt),
      pdfFileKey: 'test/key.pdf',
      pdfSha256: 'a'.repeat(64),
      templateVersion: '1',
      paperSize: 'a4',
      signatureMethod: 'test_key',
      signature: 'sig',
      verificationCode: randomUUID(),
      ...(voided
        ? {
            voidedAt: new Date(signedAt),
            voidedByUserId: clinics.a.doctor.userId,
            voidReason: 'Wrong patient',
            voidPdfFileKey: 'test/void.pdf',
          }
        : {}),
    },
  });
}

/** Bills a completed visit at the fee and takes a payment at the harness clock. */
async function paid(appointmentId: string, amountPaise: number) {
  const bill = await call('PUT', `/appointments/${appointmentId}/bill`, desk, {
    revision: 0,
    consultation: 'consultation',
    items: [],
  });
  expect(bill.statusCode).toBe(200);
  const res = await call('POST', `/bills/${Bill.parse(bill.json()).id}/payments`, desk, {
    id: randomUUID(),
    mode: 'cash',
    amountPaise,
    reference: null,
  });
  expect(res.statusCode).toBe(201);
  return Payment.parse(res.json());
}

describe('dashboard', () => {
  it('counts a range of IST days for the clinic admin only', async () => {
    // 5 Oct: one completed, one no-show. 6 Oct: completed, cancelled, rescheduled (not
    // counted) and booked. 7 Oct is outside the range.
    const done5 = await visit('2026-10-05', 'completed');
    await visit('2026-10-05', 'no_show', 1);
    const done6 = await visit('2026-10-06', 'completed');
    await visit('2026-10-06', 'cancelled', 1);
    await visit('2026-10-06', 'rescheduled', 1);
    await visit('2026-10-06', 'confirmed', 1);
    await visit('2026-10-07', 'completed');

    await signedPrescription(done5, '2026-10-05T06:00:00Z');
    await signedPrescription(done6, '2026-10-06T06:00:00Z');
    await signedPrescription(await visit('2026-10-06', 'completed', 1), '2026-10-06T07:00:00Z', {
      voided: true,
      patient: 1,
    });
    // A patient registered on 6 Oct (IST) and one long before the range.
    await h.owner.patient.update({
      where: { id: clinics.a.patients[0]!.id },
      data: { createdAt: new Date('2026-10-05T20:00:00Z') },
    });
    await h.owner.patient.update({
      where: { id: clinics.a.patients[1]!.id },
      data: { createdAt: new Date('2026-09-01T06:00:00Z') },
    });
    await paid(done6, 50000);

    const res = await call('GET', '/dashboard?from=2026-10-05&to=2026-10-06', admin);
    expect(res.statusCode).toBe(200);
    const report = DashboardReport.parse(res.json());
    expect(report).toMatchObject({
      from: '2026-10-05',
      to: '2026-10-06',
      newPatients: 1,
      // The voided prescription's visit is a completed one on 6 Oct.
      appointments: 6,
      completed: 3,
      cancelled: 1,
      noShows: 1,
      noShowRate: 0.25,
      prescriptions: 2,
      collectionsPaise: 50000,
    });
    expect(report.byDay).toEqual([
      {
        date: '2026-10-05',
        appointments: 2,
        completed: 1,
        cancelled: 0,
        noShows: 1,
        collectionsPaise: 0,
      },
      {
        date: '2026-10-06',
        appointments: 4,
        completed: 2,
        cancelled: 1,
        noShows: 0,
        collectionsPaise: 50000,
      },
    ]);

    // Defaults to the seven days ending today.
    const week = DashboardReport.parse((await call('GET', '/dashboard', admin)).json());
    expect(week).toMatchObject({ from: '2026-09-30', to: '2026-10-06', completed: 3 });
    expect(week.byDay).toHaveLength(7);

    // Another clinic sees none of it; other roles cannot read it.
    const other = DashboardReport.parse(
      (await call('GET', '/dashboard?from=2026-10-05&to=2026-10-06', adminB)).json(),
    );
    expect(other).toMatchObject({ appointments: 0, collectionsPaise: 0, noShowRate: null });
    expect((await call('GET', '/dashboard', doctor)).statusCode).toBe(403);
    expect((await call('GET', '/dashboard', desk)).statusCode).toBe(403);
  });

  it('refuses a reversed or too long range', async () => {
    expect((await call('GET', '/dashboard?from=2026-10-07&to=2026-10-06', admin)).statusCode).toBe(
      400,
    );
    expect((await call('GET', '/dashboard?from=2026-01-01&to=2026-10-06', admin)).statusCode).toBe(
      400,
    );
    // A start alone is checked against today.
    expect((await call('GET', '/dashboard?from=2026-10-07', admin)).statusCode).toBe(400);
    expect((await call('GET', '/dashboard?from=2026-07-07&to=2026-10-06', admin)).statusCode).toBe(
      200,
    );
  });
});

describe('audit log', () => {
  it('filters by action, staff member and IST day, and names staff only', async () => {
    const done = await visit('2026-10-06', 'completed');
    await paid(done, 80000);
    // A patient's own sign-in leaves an entry with them as the actor.
    const patientUser = await h.owner.user.create({
      data: { phone: '+919999900001', displayName: 'Asha Verma' },
    });
    await h.owner.membership.create({
      data: { organisationId: clinics.a.org.id, userId: patientUser.id, role: 'patient' },
    });
    await h.owner.auditLog.create({
      data: {
        organisationId: clinics.a.org.id,
        actorUserId: patientUser.id,
        action: 'auth.otp.verified',
        at: new Date('2026-10-06T05:00:00Z'),
      },
    });
    // An entry from the day before, by the doctor.
    await h.owner.auditLog.create({
      data: {
        organisationId: clinics.a.org.id,
        actorUserId: clinics.a.doctor.userId,
        action: 'chart.viewed',
        entityType: 'patient',
        entityId: clinics.a.patients[0]!.id,
        at: new Date('2026-10-05T05:00:00Z'),
      },
    });

    const list = async (query: string) => {
      const res = await call('GET', `/audit-log?${query}`, admin);
      expect(res.statusCode).toBe(200);
      return AuditListResponse.parse(res.json()).data;
    };

    const billing = await list('action=bill.');
    expect(billing.map((e) => e.action)).toEqual(['bill.saved']);
    expect(billing[0]).toMatchObject({ actorUserId: deskUserId, actorName: 'desk@clinic-a.test' });

    const byDesk = await list(`actorUserId=${deskUserId}`);
    // The front desk's own sign-in is there too; every entry is theirs.
    expect(byDesk.map((e) => e.action)).toEqual(
      expect.arrayContaining(['bill.saved', 'payment.recorded', 'auth.login.succeeded']),
    );
    expect(byDesk.every((e) => e.actorUserId === deskUserId)).toBe(true);

    const patientEntry = (await list('action=auth.otp')).find(
      (e) => e.actorUserId === patientUser.id,
    );
    expect(patientEntry).toMatchObject({ actorName: null });
    expect(JSON.stringify(await list('limit=100'))).not.toContain('Asha Verma');

    expect((await list('from=2026-10-05&to=2026-10-05')).map((e) => e.action)).toEqual([
      'chart.viewed',
    ]);
    expect((await list('action=chart&from=2026-10-06')).length).toBe(0);

    expect((await call('GET', '/audit-log?action=Bad Action', admin)).statusCode).toBe(400);
    expect((await call('GET', '/audit-log?from=2026-10-07&to=2026-10-06', admin)).statusCode).toBe(
      400,
    );
    expect((await call('GET', '/audit-log', desk)).statusCode).toBe(403);
  });

  it('pages through a filtered log', async () => {
    for (let i = 0; i < 5; i += 1) {
      await h.owner.auditLog.create({
        data: {
          organisationId: clinics.a.org.id,
          actorUserId: clinics.a.doctor.userId,
          action: 'chart.viewed',
          at: new Date(Date.UTC(2026, 9, 6, 5, i)),
        },
      });
    }
    const first = AuditListResponse.parse(
      (await call('GET', '/audit-log?action=chart.viewed&limit=3', admin)).json(),
    );
    expect(first.data).toHaveLength(3);
    const second = AuditListResponse.parse(
      (
        await call(
          'GET',
          `/audit-log?action=chart.viewed&limit=3&cursor=${first.nextCursor}`,
          admin,
        )
      ).json(),
    );
    expect(second.data).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.data, ...second.data].map((e) => e.id)).size).toBe(5);
  });
});
