import { PatientDetail, PatientListResponse, TagList, type TokenResponse } from '@dhc/contracts';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addStaff,
  bearer,
  createHarness,
  resetDatabase,
  seedTwoClinics,
  staffLogin,
  type StaffFixture,
} from './harness';

const h = createHarness();
let clinics: Awaited<ReturnType<typeof seedTwoClinics>>;
let frontDeskA: StaffFixture;
let desk: TokenResponse;
let adminA: TokenResponse;

beforeEach(async () => {
  await resetDatabase(h.owner);
  clinics = await seedTwoClinics(h);
  frontDeskA = await addStaff(h, clinics.a.org.id, 'front_desk', 'desk@clinic-a.test');
  desk = await staffLogin(h, 'clinic-a', frontDeskA);
  adminA = await staffLogin(h, 'clinic-a', clinics.a.admin);
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

async function register(payload: Record<string, unknown>, tokens = desk) {
  const res = await call('POST', '/patients', tokens, payload);
  expect(res.statusCode, res.body).toBe(201);
  return PatientDetail.parse(res.json());
}

const asha = { name: 'Neha Kapoor', phone: '98765 43210', dob: '1997-11-23', gender: 'female' };

describe('registering patients', () => {
  it('assigns UHIDs from the clinic’s prefix and number, in order', async () => {
    const settings = await call('PUT', '/uhid-settings', adminA, {
      prefix: 'ek',
      nextNumber: 10001,
    });
    expect(settings.json()).toEqual({ prefix: 'EK', nextNumber: 10001, nextUhid: 'EK10001' });

    const first = await register(asha);
    const second = await register({ name: 'Aarav Singh', phone: '9876500000' });
    expect([first.uhid, second.uhid]).toEqual(['EK10001', 'EK10002']);
    expect(first).toMatchObject({ phone: '+919876543210', dob: '1997-11-23', gender: 'female' });

    const next = await call('GET', '/uhid-settings', desk);
    expect(next.json().nextUhid).toBe('EK10003');
  });

  it('starts at 10001 with no prefix until an admin configures UHIDs', async () => {
    expect((await register(asha)).uhid).toBe('10001');
  });

  it('skips UHIDs already in use (imported patients keep theirs)', async () => {
    await call('PUT', '/uhid-settings', adminA, { prefix: 'EK', nextNumber: 500 });
    await h.owner.patient.create({
      data: { organisationId: clinics.a.org.id, uhid: 'EK500', name: 'Imported Synthetic' },
    });
    expect((await register(asha)).uhid).toBe('EK501');
  });

  it('never hands out the same UHID twice under concurrent registrations', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        call('POST', '/patients', desk, { name: `Synthetic ${i}`, phone: `90000000${10 + i}` }),
      ),
    );
    const uhids = results.map((r) => r.json().uhid);
    expect(new Set(uhids).size).toBe(8);
  });

  it('warns about likely duplicates and registers anyway when told to', async () => {
    const existing = await register(asha);

    const check = await call('POST', '/patients/duplicate-check', desk, {
      name: '  neha   kapoor ',
      phone: '+91 98765-43210',
    });
    expect(check.json().candidates.map((c: { id: string }) => c.id)).toEqual([existing.id]);

    const byDob = await call('POST', '/patients/duplicate-check', desk, {
      name: 'Neha Kapoor',
      dob: '1997-11-23',
    });
    expect(byDob.json().candidates).toHaveLength(1);

    const blocked = await call('POST', '/patients', desk, asha);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.fields.duplicates).toBe(existing.id);

    const forced = await register({ ...asha, allowDuplicate: true });
    expect(forced.uhid).not.toBe(existing.uhid);
    const audit = await h.owner.auditLog.findFirst({
      where: { action: 'patient.created', entityId: forced.id },
    });
    expect(audit?.metadata).toMatchObject({ duplicateOverride: true });
  });

  it('lets a family share one number without flagging duplicates', async () => {
    const parent = await register(asha);
    const sibling = await register({ name: 'Ravi Kapoor', phone: '9876543210' });
    const detail = PatientDetail.parse((await call('GET', `/patients/${parent.id}`, desk)).json());
    expect(detail.family).toEqual([
      { id: sibling.id, uhid: sibling.uhid, name: 'Ravi Kapoor', relation: 'same_phone' },
    ]);
  });

  it('links a child without a phone to a guardian, one level deep', async () => {
    const parent = await register(asha);
    const child = await register({
      name: 'Aarav Kapoor',
      dob: '2020-05-09',
      guardianPatientId: parent.id,
    });
    expect(child.guardian).toEqual({ id: parent.id, uhid: parent.uhid, name: parent.name });

    const parentView = PatientDetail.parse(
      (await call('GET', `/patients/${parent.id}`, desk)).json(),
    );
    expect(parentView.family).toContainEqual(
      expect.objectContaining({ id: child.id, relation: 'dependant' }),
    );

    // No phone and no guardian: someone must be reachable.
    const orphan = await call('POST', '/patients', desk, { name: 'No Contact' });
    expect(orphan.statusCode).toBe(400);
    expect(orphan.json().error.fields).toEqual({ phone: 'required' });

    // A child cannot be a guardian, and a guardian cannot get a guardian.
    const grandchild = await call('POST', '/patients', desk, {
      name: 'X',
      guardianPatientId: child.id,
    });
    expect(grandchild.statusCode).toBe(400);
    const other = await register({ name: 'Other Adult', phone: '9123456780' });
    const loop = await call('PATCH', `/patients/${parent.id}`, desk, {
      guardianPatientId: other.id,
    });
    expect(loop.statusCode).toBe(400);
  });

  it('rejects bad phone numbers and impossible dates', async () => {
    const phone = await call('POST', '/patients', desk, { name: 'X', phone: '12345' });
    expect(phone.json().error.fields).toEqual({ phone: 'invalid' });
    const future = await call('POST', '/patients', desk, {
      name: 'X',
      phone: '9876543210',
      dob: '2999-01-01',
    });
    expect(future.json().error.fields).toEqual({ dob: 'invalid' });
  });

  it('is open to front desk, doctors and admins; edits are audited by field name only', async () => {
    const doctor = await staffLogin(h, 'clinic-a', clinics.a.doctor);
    const byDoctor = await register(asha, doctor);
    await register({ name: 'Admin Registered', phone: '9000000001' }, adminA);

    const edit = await call('PATCH', `/patients/${byDoctor.id}`, desk, {
      address: '12 Synthetic Road',
      bloodGroup: 'O+',
      email: null,
    });
    expect(edit.statusCode, edit.body).toBe(200);
    expect(edit.json()).toMatchObject({ address: '12 Synthetic Road', bloodGroup: 'O+' });

    const audit = await h.owner.auditLog.findFirst({
      where: { action: 'patient.updated', entityId: byDoctor.id },
    });
    expect(audit?.metadata).toEqual({ fields: ['email', 'address', 'bloodGroup'] });
    expect(JSON.stringify(audit)).not.toContain('Synthetic Road');
  });

  it('keeps registration and edits inside the caller’s clinic', async () => {
    const otherClinicPatient = clinics.b.patients[0]!;
    const edit = await call('PATCH', `/patients/${otherClinicPatient.id}`, desk, { address: 'x' });
    expect(edit.statusCode).toBe(404);
    const guardian = await call('POST', '/patients', desk, {
      name: 'Cross Clinic',
      guardianPatientId: otherClinicPatient.id,
    });
    expect(guardian.statusCode).toBe(400);
  });
});

describe('tags', () => {
  async function defaults() {
    const res = await call('POST', '/tags/defaults', adminA);
    expect(res.statusCode).toBe(200);
    return TagList.parse(res.json()).data;
  }

  it('gives admins the default tags once, with Emergency and Priority sorting to the top', async () => {
    const first = await defaults();
    expect(first.map((t) => t.name)).toEqual([
      'Emergency',
      'Priority',
      '2nd opinion',
      'Complaint',
      'Insurance',
      'VIP',
    ]);
    expect(first.filter((t) => t.sortToTop).map((t) => t.name)).toEqual(['Emergency', 'Priority']);
    expect(await defaults()).toHaveLength(6);
  });

  it('lets front desk tag patients and filter the list by tag', async () => {
    const [emergency, priority] = await defaults();
    const p = await register({ ...asha, tagIds: [emergency!.id] });
    expect(p.tags.map((t) => t.name)).toEqual(['Emergency']);
    await register({ name: 'Untagged Synthetic', phone: '9000000002' });

    const set = await call('PUT', `/patients/${p.id}/tags`, desk, { tagIds: [priority!.id] });
    expect(set.json().tags.map((t: { name: string }) => t.name)).toEqual(['Priority']);

    const filtered = PatientListResponse.parse(
      (await call('GET', `/patients?tagId=${priority!.id}`, desk)).json(),
    );
    expect(filtered.data.map((x) => x.id)).toEqual([p.id]);

    const audit = await h.owner.auditLog.findFirst({ where: { action: 'patient.tags.changed' } });
    expect(audit?.metadata).toEqual({ added: [priority!.id], removed: [emergency!.id] });
  });

  it('keeps archived tags on patients but stops new assignments', async () => {
    const [emergency] = await defaults();
    const p = await register({ ...asha, tagIds: [emergency!.id] });
    await call('PATCH', `/tags/${emergency!.id}`, adminA, { archived: true });

    const kept = await call('PUT', `/patients/${p.id}/tags`, desk, { tagIds: [emergency!.id] });
    expect(kept.statusCode).toBe(200);
    const other = await register({ name: 'Second Synthetic', phone: '9000000003' });
    const blocked = await call('PUT', `/patients/${other.id}/tags`, desk, {
      tagIds: [emergency!.id],
    });
    expect(blocked.statusCode).toBe(400);
  });

  it('limits configuration to admins and assignment to front desk and doctors', async () => {
    expect((await call('POST', '/tags', desk, { name: 'X', colour: '#000000' })).statusCode).toBe(
      403,
    );
    const [vip] = await defaults();
    const p = await register(asha);
    expect(
      (await call('PUT', `/patients/${p.id}/tags`, adminA, { tagIds: [vip!.id] })).statusCode,
    ).toBe(403);
    expect(
      (await call('PUT', '/uhid-settings', desk, { prefix: 'X', nextNumber: 1 })).statusCode,
    ).toBe(403);

    const dup = await call('POST', '/tags', adminA, { name: 'VIP', colour: '#123456' });
    expect(dup.statusCode).toBe(409);
  });

  it('never shows or assigns another clinic’s tags', async () => {
    const tagsA = await defaults();
    const adminB = await staffLogin(h, 'clinic-b', clinics.b.admin);
    expect(TagList.parse((await call('GET', '/tags', adminB)).json()).data).toEqual([]);

    const doctorB = await staffLogin(h, 'clinic-b', clinics.b.doctor);
    const res = await call('PUT', `/patients/${clinics.b.patients[0]!.id}/tags`, doctorB, {
      tagIds: [tagsA[0]!.id],
    });
    expect(res.statusCode).toBe(400);
  });
});
