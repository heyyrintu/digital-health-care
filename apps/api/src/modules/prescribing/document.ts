import { ConsultationNotes } from '@dhc/contracts';
import type { Tx } from '@dhc/db';
import { ageFrom, bmiOf } from '@dhc/domain';
import type { FieldCipher } from '../../auth/field-cipher';
import type { RxDocument } from './pdf';
import { fromDbDate, type PrescriptionRow } from './shared';

const num = (d: { toString(): string } | null) => (d === null ? null : Number(d.toString()));

/**
 * Reads what the PDF prints for a version (PRD §6.6) inside the caller's tenant
 * transaction: the visit, patient, clinic, vitals, the doctor's notes (decrypted; never
 * the private notes) and the active allergies on the chart.
 */
export async function loadDocument(
  tx: Tx,
  cipher: FieldCipher,
  row: PrescriptionRow,
  doctor: {
    name: string;
    profile: {
      qualifications: string | null;
      specialty: string | null;
      registrationNumber: string | null;
      council: string | null;
      paperSize: 'a4' | 'a5';
    } | null;
  },
  extra: Pick<RxDocument, 'watermark' | 'number' | 'signature' | 'verificationUrl'> & {
    amendmentDate: string | null;
  },
): Promise<RxDocument> {
  const visit = await tx.appointment.findUniqueOrThrow({
    where: { id: row.appointmentId },
    include: {
      patient: true,
      clinic: true,
      consultationType: { select: { mode: true } },
      vitals: true,
      consultation: true,
      organisation: { select: { name: true } },
    },
  });
  const allergies = await tx.allergy.findMany({
    where: { patientId: visit.patientId, removedAt: null },
    orderBy: { createdAt: 'asc' },
    select: { substance: true },
  });
  const notes = visit.consultation
    ? ConsultationNotes.parse(JSON.parse(cipher.decrypt(visit.consultation.notesCipher)))
    : ConsultationNotes.parse({});
  const date = fromDbDate(visit.date);
  const v = visit.vitals;
  const weightKg = num(v?.weightKg ?? null);
  const heightCm = num(v?.heightCm ?? null);
  const items = row.items;
  return {
    language: row.language,
    paperSize: row.paperSize ?? doctor.profile?.paperSize ?? 'a5',
    watermark: extra.watermark,
    doctor: {
      name: doctor.name,
      qualifications: doctor.profile?.qualifications ?? null,
      specialty: doctor.profile?.specialty ?? null,
      registrationNumber: doctor.profile?.registrationNumber ?? null,
      council: doctor.profile?.council ?? null,
    },
    clinic: { name: visit.clinic.name, address: visit.clinic.address, phone: visit.clinic.phone },
    organisationName: visit.organisation.name,
    patient: {
      name: visit.patient.name,
      age: visit.patient.dob ? ageFrom(fromDbDate(visit.patient.dob), date) : null,
      gender: visit.patient.gender,
      uhid: visit.patient.uhid,
    },
    date,
    mode: visit.consultationType.mode,
    number: extra.number,
    version: row.version,
    amendment:
      row.amendmentReason && extra.amendmentDate
        ? { reason: row.amendmentReason, date: extra.amendmentDate }
        : null,
    void: null,
    vitals: v
      ? {
          bpSystolic: v.bpSystolic,
          bpDiastolic: v.bpDiastolic,
          pulse: v.pulse,
          temperatureC: num(v.temperatureC),
          spo2: v.spo2,
          weightKg,
          heightCm,
          bmi: bmiOf(weightKg, heightCm),
        }
      : null,
    complaints: [
      notes.chiefComplaint.trim(),
      ...notes.symptoms.map((s) => (s.duration ? `${s.text} (${s.duration})` : s.text)),
    ].filter(Boolean),
    diagnoses: notes.diagnoses.map((d) => (d.code ? `${d.label} (${d.code})` : d.label)),
    allergies: allergies.map((a) => a.substance),
    items: items.map((i) => ({
      name: i.name,
      generic: i.composition,
      steps: i.steps as RxDocument['items'][number]['steps'],
      quantity: i.quantity,
      instructions: i.instructions,
      remarks: i.remarks,
    })),
    testsAdvised: notes.testsAdvised,
    advice: notes.advice,
    followUpDate: visit.consultation?.followUpDate
      ? fromDbDate(visit.consultation.followUpDate)
      : null,
    signature: extra.signature,
    verificationUrl: extra.verificationUrl,
  };
}
