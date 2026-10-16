import {
  CURRENT_CONSENT_VERSIONS,
  ConsentStatus,
  PortalPatient,
  PortalPatientList,
  type TokenResponse,
} from '@dhc/contracts';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addStaff,
  bearer,
  createHarness,
  patientLogin,
  resetDatabase,
  seedTwoClinics,
  staffLogin,
} from './harness';

const h = createHarness();
let clinics: Awaited<ReturnType<typeof seedTwoClinics>>;
let desk: TokenResponse;

beforeEach(async () => {
  await resetDatabase(h.owner);
  clinics = await seedTwoClinics(h);
  const frontDesk = await addStaff(h, clinics.a.org.id, 'front_desk', 'desk@clinic-a.test');
  desk = await staffLogin(h, 'clinic-a', frontDesk);
});

afterAll(async () => {
  await h.app.close();
  await h.owner.$disconnect();
});

const call = (method: string, url: string, tokens: TokenResponse, payload?: unknown) =>
  h.app.inject({
    method: method as 'GET',
    url: `/v1${url}`,
    headers: bearer(tokens),
    payload: payload as object,
  });

const ALL = Object.entries(CURRENT_CONSENT_VERSIONS).map(([kind, version]) => ({ kind, version }));

async function signedUp(phone: string, organisation = 'clinic-a') {
  const tokens = await patientLogin(h, organisation, phone);
  const res = await call('POST', '/portal/consents', tokens, { accept: ALL });
  expect(res.statusCode, res.body).toBe(200);
  return tokens;
}

async function registerAtDesk(payload: Record<string, unknown>) {
  const res = await call('POST', '/patients', desk, payload);
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; uhid: string };
}

describe('consents', () => {
  it('asks for all three, records each acceptance with its version, and audits it', async () => {
    const tokens = await patientLogin(h, 'clinic-a', '9876543210');
    const before = ConsentStatus.parse((await call('GET', '/portal/consents', tokens)).json());
    expect(before).toEqual({ consents: [], pending: ['privacy_notice', 'terms', 'health_data'] });

    const after = ConsentStatus.parse(
      (await call('POST', '/portal/consents', tokens, { accept: ALL })).json(),
    );
    expect(after.pending).toEqual([]);
    expect(after.consents.map((c) => c.kind).sort()).toEqual([
      'health_data',
      'privacy_notice',
      'terms',
    ]);

    // Accepting again adds nothing.
    await call('POST', '/portal/consents', tokens, { accept: ALL });
    expect(await h.owner.accountConsent.count()).toBe(3);
    const audit = await h.owner.auditLog.findMany({ where: { action: 'consent.accepted' } });
    expect(audit).toHaveLength(1);
  });

  it('records one acceptance when two arrive at once', async () => {
    const tokens = await patientLogin(h, 'clinic-a', '9876543210');
    const both = await Promise.all([
      call('POST', '/portal/consents', tokens, { accept: ALL }),
      call('POST', '/portal/consents', tokens, { accept: ALL }),
    ]);
    expect(both.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(await h.owner.accountConsent.count()).toBe(3);
  });

  it('refuses an outdated version', async () => {
    const tokens = await patientLogin(h, 'clinic-a', '9876543210');
    const res = await call('POST', '/portal/consents', tokens, {
      accept: [{ kind: 'terms', version: '2020-01' }],
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.fields).toEqual({ terms: 'outdated' });
  });

  it('keeps health data closed until every consent is accepted, and after withdrawal', async () => {
    const tokens = await patientLogin(h, 'clinic-a', '9876543210');
    const blocked = await call('GET', '/portal/patients', tokens);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('CONSENT_REQUIRED');

    await call('POST', '/portal/consents', tokens, { accept: ALL });
    expect((await call('GET', '/portal/patients', tokens)).statusCode).toBe(200);

    const res = await call('POST', '/portal/consents/health_data/withdraw', tokens);
    expect(res.statusCode, res.body).toBe(200);
    const withdrawn = ConsentStatus.parse(res.json());
    expect(withdrawn.pending).toEqual(['health_data']);
    expect(withdrawn.consents.find((c) => c.kind === 'health_data')?.withdrawnAt).not.toBeNull();
    expect((await call('GET', '/portal/patients', tokens)).statusCode).toBe(403);

    // Accepting again opens it; the withdrawn row stays on record.
    await call('POST', '/portal/consents', tokens, {
      accept: [{ kind: 'health_data', version: CURRENT_CONSENT_VERSIONS.health_data }],
    });
    expect((await call('GET', '/portal/patients', tokens)).statusCode).toBe(200);
    expect(await h.owner.accountConsent.count({ where: { kind: 'health_data' } })).toBe(2);
  });

  it('is for patients only', async () => {
    expect((await call('GET', '/portal/consents', desk)).statusCode).toBe(403);
    expect((await call('GET', '/portal/patients', desk)).statusCode).toBe(403);
  });
});

describe('the account’s patients', () => {
  it('claims the records the clinic registered on this number, with their dependants', async () => {
    const neha = await registerAtDesk({
      name: 'Neha Kapoor',
      phone: '98765 43210',
      dob: '1997-11-23',
      gender: 'female',
    });
    const husband = await registerAtDesk({ name: 'Rohan Kapoor', phone: '9876543210' });
    const child = await registerAtDesk({ name: 'Aarav Kapoor', guardianPatientId: neha.id });
    await registerAtDesk({ name: 'Someone Else', phone: '9000000001' });

    const tokens = await signedUp('9876543210');
    const list = PortalPatientList.parse((await call('GET', '/portal/patients', tokens)).json());
    expect(list.data.map((p) => [p.id, p.relation, p.guardianPatientId])).toEqual([
      [neha.id, 'account', null],
      [child.id, 'dependant', neha.id],
      [husband.id, 'account', null],
    ]);
  });

  it('leaves out records merged into another one', async () => {
    const kept = await registerAtDesk({ name: 'Neha Kapoor', phone: '9876543210' });
    const duplicate = await registerAtDesk({ name: 'Neha K', phone: '9876543210' });
    await h.owner.patient.update({
      where: { id: duplicate.id },
      data: { mergedIntoId: kept.id, mergedAt: new Date() },
    });
    const tokens = await signedUp('9876543210');
    const list = PortalPatientList.parse((await call('GET', '/portal/patients', tokens)).json());
    expect(list.data.map((p) => p.id)).toEqual([kept.id]);
  });

  it('never shows another account’s or another clinic’s records', async () => {
    await registerAtDesk({ name: 'Neha Kapoor', phone: '9876543210' });
    const other = await signedUp('9000000001');
    expect((await call('GET', '/portal/patients', other)).json().data).toEqual([]);

    // Same number at clinic B: a separate account there, with nothing of clinic A's.
    const atB = await signedUp('9876543210', 'clinic-b');
    expect((await call('GET', '/portal/patients', atB)).json().data).toEqual([]);
  });

  it('adds the person, then a child they look after, each with a UHID', async () => {
    const tokens = await signedUp('9876543210');
    const self = await call('POST', '/portal/patients', tokens, {
      name: '  Neha   Kapoor ',
      dob: '1997-11-23',
      gender: 'female',
      language: 'hi',
    });
    expect(self.statusCode, self.body).toBe(201);
    const me = PortalPatient.parse(self.json());
    expect(me).toMatchObject({ name: 'Neha Kapoor', relation: 'account', language: 'hi' });
    expect(me.uhid).toBe('10001');

    const kid = await call('POST', '/portal/patients', tokens, {
      name: 'Aarav Kapoor',
      dob: '2020-02-02',
      gender: 'male',
      guardianPatientId: me.id,
    });
    expect(kid.statusCode, kid.body).toBe(201);
    expect(kid.json()).toMatchObject({ relation: 'dependant', guardianPatientId: me.id });

    const row = await h.owner.patient.findUniqueOrThrow({ where: { id: kid.json().id } });
    expect(row).toMatchObject({ phone: null, guardianPatientId: me.id });
    expect(row.accountUserId).not.toBeNull();

    // The clinic sees both as ordinary records.
    const atDesk = await call('GET', `/patients/${me.id}`, desk);
    expect(atDesk.json().family).toEqual([
      expect.objectContaining({ id: kid.json().id, relation: 'dependant' }),
    ]);
    const audit = await h.owner.auditLog.findMany({ where: { action: 'patient.created' } });
    expect(audit).toHaveLength(2);
    expect(audit.map((a) => a.metadata)).toEqual(
      expect.arrayContaining([
        { source: 'patient_app', dependant: false },
        { source: 'patient_app', dependant: true },
      ]),
    );
  });

  it('does not add the same person twice', async () => {
    await registerAtDesk({ name: 'Neha Kapoor', phone: '9876543210', dob: '1997-11-23' });
    const tokens = await signedUp('9876543210');
    const again = await call('POST', '/portal/patients', tokens, {
      name: 'neha kapoor',
      dob: '1997-11-23',
      gender: 'female',
    });
    expect(again.statusCode).toBe(409);
  });

  it('only lets an adult on this account be a guardian', async () => {
    const stranger = await registerAtDesk({ name: 'Someone Else', phone: '9000000001' });
    const tokens = await signedUp('9876543210');
    const me = PortalPatient.parse(
      (
        await call('POST', '/portal/patients', tokens, {
          name: 'Neha Kapoor',
          dob: '1997-11-23',
          gender: 'female',
        })
      ).json(),
    );
    const kid = PortalPatient.parse(
      (
        await call('POST', '/portal/patients', tokens, {
          name: 'Aarav Kapoor',
          dob: '2020-02-02',
          gender: 'male',
          guardianPatientId: me.id,
        })
      ).json(),
    );

    const viaStranger = await call('POST', '/portal/patients', tokens, {
      name: 'Baby Kapoor',
      dob: '2025-01-01',
      gender: 'female',
      guardianPatientId: stranger.id,
    });
    expect(viaStranger.statusCode).toBe(404);

    const viaChild = await call('POST', '/portal/patients', tokens, {
      name: 'Baby Kapoor',
      dob: '2025-01-01',
      gender: 'female',
      guardianPatientId: kid.id,
    });
    expect(viaChild.statusCode).toBe(400);

    // A teenager on the account's own number is still not a guardian.
    const teen = await registerAtDesk({
      name: 'Riya Kapoor',
      phone: '9876543210',
      dob: '2010-06-01',
      gender: 'female',
    });
    const viaTeen = await call('POST', '/portal/patients', tokens, {
      name: 'Baby Kapoor',
      dob: '2025-01-01',
      gender: 'female',
      guardianPatientId: teen.id,
    });
    expect(viaTeen.statusCode).toBe(400);

    // And a child is added with a guardian, never on their own.
    const alone = await call('POST', '/portal/patients', tokens, {
      name: 'Kabir Kapoor',
      dob: '2018-03-03',
      gender: 'male',
    });
    expect(alone.statusCode).toBe(400);
    expect(alone.json().error.fields).toEqual({ guardianPatientId: expect.any(String) });
  });

  it('keeps a withdrawal final in the database', async () => {
    const tokens = await signedUp('9876543210');
    await call('POST', '/portal/consents/health_data/withdraw', tokens);
    await expect(
      h.owner.accountConsent.updateMany({
        where: { kind: 'health_data' },
        data: { withdrawnAt: null },
      }),
    ).rejects.toThrow(/stays withdrawn/);
  });

  it('refuses a date of birth in the future', async () => {
    const tokens = await signedUp('9876543210');
    const res = await call('POST', '/portal/patients', tokens, {
      name: 'Neha Kapoor',
      dob: '2030-01-01',
      gender: 'female',
    });
    expect(res.statusCode).toBe(400);
  });

  it('accepts a baby born today in India, before it is today in UTC', async () => {
    const saved = h.clock.ms;
    // 00:30 IST on 7 Oct is still 6 Oct in UTC.
    h.clock.ms = Date.UTC(2026, 9, 6, 19, 0);
    try {
      const tokens = await signedUp('9876543210');
      const mother = await call('POST', '/portal/patients', tokens, {
        name: 'Neha Kapoor',
        dob: '1997-11-23',
        gender: 'female',
      });
      const baby = await call('POST', '/portal/patients', tokens, {
        name: 'Baby Kapoor',
        dob: '2026-10-07',
        gender: 'female',
        guardianPatientId: mother.json().id,
      });
      expect(baby.statusCode, baby.body).toBe(201);
    } finally {
      h.clock.ms = saved;
    }
  });
});
