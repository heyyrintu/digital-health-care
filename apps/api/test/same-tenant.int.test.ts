import { type Tx, withTenant } from '@dhc/db';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, resetDatabase, seedTwoClinics } from './harness';

/**
 * Foreign keys do not see row-level security, so a write scoped to clinic B could name
 * clinic A's rows by ID. A trigger on every tenant-to-tenant reference rejects that.
 * Each case first writes the row against clinic B's own parents (it must succeed, so a
 * rejection below is the trigger and not a missing grant or a bad fixture), then the
 * same row against clinic A's.
 */
const h = createHarness();
let clinics: Awaited<ReturnType<typeof seedTwoClinics>>;

// The trigger's own message, so a rejection by RLS, a grant or another trigger fails the test.
const MISMATCH = /does not match a \w+ row in the same organisation/;

/** One clinic's parent rows: a clinic, a consultation type, a tag, a visit and a medicine. */
async function parents(side: 'a' | 'b') {
  const c = clinics[side];
  const org = c.org.id;
  const clinic = await h.owner.clinic.create({ data: { organisationId: org, name: 'Main' } });
  const type = await h.owner.consultationType.create({
    data: {
      organisationId: org,
      name: 'In-person',
      mode: 'in_person',
      defaultDurationMin: 15,
      feePaise: 50000,
    },
  });
  const tag = await h.owner.tag.create({
    data: { organisationId: org, name: 'VIP', colour: '#aa0000' },
  });
  const startAt = new Date('2026-10-06T04:30:00.000Z');
  const appointment = await h.owner.appointment.create({
    data: {
      organisationId: org,
      patientId: c.patients[0]!.id,
      doctorUserId: c.doctor.userId,
      clinicId: clinic.id,
      consultationTypeId: type.id,
      date: new Date('2026-10-06T00:00:00.000Z'),
      startAt,
      endAt: new Date(startAt.getTime() + 15 * 60_000),
      status: 'in_consultation',
      source: 'front_desk',
      tokenNumber: 1,
      createdByUserId: c.doctor.userId,
    },
  });
  const prescription = await h.owner.prescription.create({
    data: {
      organisationId: org,
      appointmentId: appointment.id,
      patientId: c.patients[0]!.id,
      doctorUserId: c.doctor.userId,
      language: 'en',
    },
  });
  const medicine = await h.owner.medicine.create({
    data: {
      organisationId: org,
      name: `House syrup ${side}`,
      genericName: 'Syrup',
      composition: 'Syrup',
      form: 'syrup',
      source: 'clinic',
    },
  });
  return {
    patientId: c.patients[0]!.id,
    clinicId: clinic.id,
    typeId: type.id,
    tagId: tag.id,
    appointmentId: appointment.id,
    prescriptionId: prescription.id,
    medicineId: medicine.id,
  };
}

type Parents = Awaited<ReturnType<typeof parents>>;
let a: Parents;
let b: Parents;
let doctorB: string;

beforeEach(async () => {
  await resetDatabase(h.owner);
  clinics = await seedTwoClinics(h);
  a = await parents('a');
  b = await parents('b');
  doctorB = clinics.b.doctor.userId;
});

afterAll(async () => {
  await h.app.close();
  await h.owner.$disconnect();
});

const asB = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(h.services.db, clinics.b.org.id, fn);

/** Inserts as clinic B with a row built from `p`; B's own parents pass, A's are refused. */
async function guarded(write: (tx: Tx, p: Parents, org: string) => Promise<unknown>) {
  const org = clinics.b.org.id;
  await expect(asB((tx) => write(tx, b, org))).resolves.toBeDefined();
  await expect(asB((tx) => write(tx, a, org))).rejects.toThrow(MISMATCH);
}

describe('a clinic B row cannot point at a clinic A row', () => {
  it('patient register: guardian and tags', async () => {
    let n = 0;
    await guarded((tx, p, org) =>
      tx.patient.create({
        data: {
          organisationId: org,
          uhid: `GU-${String(++n).padStart(6, '0')}`,
          name: 'Dependant',
          guardianPatientId: p.patientId,
        },
      }),
    );
    await guarded((tx, p, org) =>
      tx.patientTag.create({
        data: {
          organisationId: org,
          patientId: p.patientId,
          tagId: b.tagId,
          addedByUserId: doctorB,
        },
      }),
    );
    await guarded((tx, p, org) =>
      tx.patientTag.create({
        data: {
          organisationId: org,
          patientId: clinics.b.patients[1]!.id,
          tagId: p.tagId,
          addedByUserId: doctorB,
        },
      }),
    );
  });

  it('scheduling: availability and exceptions', async () => {
    let day = 0;
    const version = (clinicId: string, typeId: string) => (tx: Tx, org: string) =>
      tx.availabilityVersion.create({
        data: {
          organisationId: org,
          doctorUserId: doctorB,
          clinicId,
          consultationTypeId: typeId,
          effectiveFrom: new Date(Date.UTC(2026, 9, 1 + ++day)),
          weekly: {},
          slotMinutes: 15,
          createdByUserId: doctorB,
        },
      });
    await guarded((tx, p, org) => version(p.clinicId, b.typeId)(tx, org));
    await guarded((tx, p, org) => version(b.clinicId, p.typeId)(tx, org));

    const exception = (clinicId: string | null, typeId: string | null) => (tx: Tx, org: string) =>
      tx.availabilityException.create({
        data: {
          organisationId: org,
          type: 'extra_session',
          doctorUserId: doctorB,
          clinicId,
          consultationTypeId: typeId,
          startDate: new Date('2026-10-10'),
          endDate: new Date('2026-10-10'),
          createdByUserId: doctorB,
        },
      });
    await guarded((tx, p, org) => exception(p.clinicId, null)(tx, org));
    await guarded((tx, p, org) => exception(null, p.typeId)(tx, org));
  });

  it('appointments, their status history and rescheduling', async () => {
    let token = 10;
    const booking =
      (
        over: Partial<
          Record<'patientId' | 'clinicId' | 'consultationTypeId' | 'rescheduledFromId', string>
        >,
      ) =>
      (tx: Tx, org: string) => {
        const startAt = new Date('2026-10-07T04:30:00.000Z');
        return tx.appointment.create({
          data: {
            organisationId: org,
            patientId: b.patientId,
            doctorUserId: doctorB,
            clinicId: b.clinicId,
            consultationTypeId: b.typeId,
            date: new Date('2026-10-07T00:00:00.000Z'),
            startAt,
            endAt: new Date(startAt.getTime() + 15 * 60_000),
            status: 'confirmed',
            source: 'front_desk',
            tokenNumber: ++token,
            createdByUserId: doctorB,
            ...over,
          },
        });
      };
    await guarded((tx, p, org) => booking({ patientId: p.patientId })(tx, org));
    await guarded((tx, p, org) => booking({ clinicId: p.clinicId })(tx, org));
    await guarded((tx, p, org) => booking({ consultationTypeId: p.typeId })(tx, org));
    await guarded((tx, p, org) => booking({ rescheduledFromId: p.appointmentId })(tx, org));

    await guarded((tx, p, org) =>
      tx.appointmentStatusHistory.create({
        data: {
          organisationId: org,
          appointmentId: p.appointmentId,
          toStatus: 'checked_in',
          actorUserId: doctorB,
          at: new Date(),
        },
      }),
    );

    // An update that repoints an existing visit is checked too. (Not the fixture visit: one
    // with a prescription may not change patient at all.)
    const visit = await asB((tx) => booking({})(tx, clinics.b.org.id));
    await expect(
      asB((tx) =>
        tx.appointment.update({ where: { id: visit.id }, data: { patientId: a.patientId } }),
      ),
    ).rejects.toThrow(MISMATCH);
  });

  it('waiting-room displays', async () => {
    await guarded((tx, p, org) =>
      tx.displayScreen.create({
        data: {
          organisationId: org,
          clinicId: p.clinicId,
          label: 'Lobby',
          tokenHash: randomUUID(),
          createdByUserId: doctorB,
        },
      }),
    );
  });

  it('patient chart: allergies, conditions and current medicines', async () => {
    const chart = { source: 'doctor' as const, recordedByUserId: doctorB };
    await guarded((tx, p, org) =>
      tx.allergy.create({
        data: { organisationId: org, patientId: p.patientId, substance: 'Penicillin', ...chart },
      }),
    );
    await guarded((tx, p, org) =>
      tx.medicalCondition.create({
        data: { organisationId: org, patientId: p.patientId, name: 'Diabetes', ...chart },
      }),
    );
    await guarded((tx, p, org) =>
      tx.currentMedication.create({
        data: { organisationId: org, patientId: p.patientId, name: 'Metformin', ...chart },
      }),
    );
  });

  it('consultations and vitals: the visit and the patient', async () => {
    const consultation = (appointmentId: string, patientId: string) => (tx: Tx, org: string) =>
      tx.consultation.create({
        data: {
          organisationId: org,
          appointmentId,
          patientId,
          doctorUserId: doctorB,
          notesCipher: 'x',
        },
      });
    const vitals = (appointmentId: string, patientId: string) => (tx: Tx, org: string) =>
      tx.vitals.create({
        data: {
          organisationId: org,
          appointmentId,
          patientId,
          pulse: 72,
          recordedByUserId: doctorB,
        },
      });
    // B's visit takes the one consultation and vitals row it may have; the A cases fail
    // on the reference before they could reach the unique index.
    await guarded((tx, p, org) => consultation(p.appointmentId, b.patientId)(tx, org));
    await expect(
      asB((tx) => consultation(b.appointmentId, a.patientId)(tx, clinics.b.org.id)),
    ).rejects.toThrow(MISMATCH);
    await guarded((tx, p, org) => vitals(p.appointmentId, b.patientId)(tx, org));
    await expect(
      asB((tx) => vitals(b.appointmentId, a.patientId)(tx, clinics.b.org.id)),
    ).rejects.toThrow(MISMATCH);
  });

  it('prescription lines: never another clinic’s own medicine', async () => {
    let sort = 0;
    const item = (medicineId: string) => (tx: Tx, org: string) =>
      tx.prescriptionItem.create({
        data: {
          id: randomUUID(),
          organisationId: org,
          prescriptionId: b.prescriptionId,
          medicineId,
          name: 'X',
          steps: [],
          remarks: '',
          sortOrder: ++sort,
        },
      });
    await guarded((tx, p, org) => item(p.medicineId)(tx, org));
    // A platform medicine (no organisation) is open to every clinic.
    const platform = await h.owner.medicine.create({
      data: {
        name: 'Platform tablet',
        genericName: 'Tablet',
        composition: 'Tablet',
        form: 'tablet',
        source: 'reference',
      },
    });
    await expect(asB((tx) => item(platform.id)(tx, clinics.b.org.id))).resolves.toBeDefined();
  });

  it('holds for the owner role too, not only under row-level security', async () => {
    await expect(
      h.owner.allergy.create({
        data: {
          organisationId: clinics.b.org.id,
          patientId: a.patientId,
          substance: 'Sulfa',
          source: 'doctor',
          recordedByUserId: doctorB,
        },
      }),
    ).rejects.toThrow(MISMATCH);
  });

  it('a temporary table named like the parent cannot stand in for it', async () => {
    const org = clinics.b.org.id;
    await expect(
      asB(async (tx) => {
        await tx.$executeRawUnsafe(
          'CREATE TEMP TABLE patients (id uuid, organisation_id uuid) ON COMMIT DROP',
        );
        await tx.$executeRawUnsafe(`INSERT INTO patients VALUES ('${a.patientId}', '${org}')`);
        return tx.allergy.create({
          data: {
            organisationId: org,
            patientId: a.patientId,
            substance: 'Sulfa',
            source: 'doctor',
            recordedByUserId: doctorB,
          },
        });
      }),
    ).rejects.toThrow(MISMATCH);
  });

  it('a referenced row keeps its organisation while anything points at it', async () => {
    const KEEPS = /is still referenced by \w+\.\w+; it keeps its organisation/;
    const orgA = clinics.a.org.id;
    const orgB = clinics.b.org.id;
    // One child per parent table, all in clinic B.
    await h.owner.displayScreen.create({
      data: {
        organisationId: orgB,
        clinicId: b.clinicId,
        label: 'Lobby',
        tokenHash: randomUUID(),
        createdByUserId: doctorB,
      },
    });
    await h.owner.patientTag.create({
      data: {
        organisationId: orgB,
        patientId: b.patientId,
        tagId: b.tagId,
        addedByUserId: doctorB,
      },
    });
    await h.owner.appointmentStatusHistory.create({
      data: {
        organisationId: orgB,
        appointmentId: b.appointmentId,
        toStatus: 'checked_in',
        actorUserId: doctorB,
        at: new Date(),
      },
    });
    await h.owner.prescriptionItem.create({
      data: {
        id: randomUUID(),
        organisationId: orgB,
        prescriptionId: b.prescriptionId,
        medicineId: b.medicineId,
        name: 'X',
        steps: [],
        remarks: '',
        sortOrder: 0,
      },
    });
    const move = { organisationId: orgA };
    // Even the owner role cannot move them to clinic A and strand the children in B.
    await expect(h.owner.clinic.update({ where: { id: b.clinicId }, data: move })).rejects.toThrow(
      KEEPS,
    );
    await expect(
      h.owner.consultationType.update({ where: { id: b.typeId }, data: move }),
    ).rejects.toThrow(KEEPS);
    await expect(
      h.owner.patient.update({ where: { id: b.patientId }, data: move }),
    ).rejects.toThrow(KEEPS);
    await expect(h.owner.tag.update({ where: { id: b.tagId }, data: move })).rejects.toThrow(KEEPS);
    // A visit also points at its own clinic, patient and type, which stay in B; either
    // refusal will do (triggers fire in name order).
    await expect(
      h.owner.appointment.update({ where: { id: b.appointmentId }, data: move }),
    ).rejects.toThrow(new RegExp(`${KEEPS.source}|${MISMATCH.source}`));
    await expect(
      h.owner.medicine.update({ where: { id: b.medicineId }, data: move }),
    ).rejects.toThrow(KEEPS);

    // A row nothing points at can still move.
    const spare = await h.owner.clinic.create({ data: { organisationId: orgB, name: 'Spare' } });
    await expect(
      h.owner.clinic.update({ where: { id: spare.id }, data: move }),
    ).resolves.toMatchObject(move);
  });
});
