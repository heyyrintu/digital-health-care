import {
  ConsultationNotes,
  type AmendPrescriptionBody,
  type Prescription,
  type PrescriptionCheck,
  type SignPrescriptionBody,
  type VoidPrescriptionBody,
} from '@dhc/contracts';
import { withAuth, withTenant, type Prisma } from '@dhc/db';
import { ageFrom } from '@dhc/domain';
import type { FastifyRequest } from 'fastify';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { hashToken } from '../../auth/tokens';
import { AppError } from '../../errors';
import { uniqueSuffix } from '../../files';
import type { Services } from '../../services';
import { writeAudit } from '../audit/write';
import { assertChartAccess } from '../clinical/access';
import { lockVisit } from '../clinical/service';
import { DoctorProfileService, findProfile, signingGaps } from '../doctors/service';
import { loadDocument } from './document';
import { PDF_TEMPLATE_VERSION, renderPrescriptionPdf, stampVoid } from './pdf';
import { checkAndRecord } from './safety';
import {
  auditVisit,
  currentPrescription,
  fromDbDate,
  NOT_FOUND,
  prescriptionOut,
  staffNames,
  verificationUrl,
  writableVisit,
  type Actor,
  type PrescriptionRow,
} from './shared';

// Crockford base32: no I, L, O or U, so a code read aloud or typed is hard to get wrong.
const BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 120 random bits as 24 characters: unguessable, and compact in a QR. */
export function verificationCode(): string {
  const bytes = randomBytes(15);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest();
const BAD_CODE = () =>
  new AppError(
    404,
    'NOT_FOUND',
    'No prescription matches this code. Check it was typed correctly.',
  );
const istDate = (at: Date) => new Date(at.getTime() + 330 * 60_000).toISOString().slice(0, 10);

/**
 * Signing, immutability and delivery (PRD §6.6): preview → sign with the PIN → the server
 * checks again → PDF → signature → locked. Corrections are new versions with a reason;
 * voiding withdraws a version and stamps its copy VOID. Pharmacies check the QR (§9.4).
 */
export class SigningService {
  private readonly profiles: DoctorProfileService;

  constructor(private readonly s: Services) {
    this.profiles = new DoctorProfileService(s);
  }

  /** The draft as it would print, marked PREVIEW, with no number, signature or QR. */
  async preview(request: FastifyRequest, actor: Actor, appointmentId: string): Promise<Buffer> {
    const doctorName = await this.doctorName(actor.userId);
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      const appointment = await tx.appointment.findUnique({ where: { id: appointmentId } });
      if (!appointment) throw NOT_FOUND();
      if (appointment.doctorUserId !== actor.userId) {
        await assertChartAccess(tx, actor, appointment.patientId);
      }
      const row = await currentPrescription(tx, appointmentId);
      if (!row || row.status !== 'draft') throw NOT_FOUND();
      const profile = await tx.doctorProfile.findUnique({
        where: {
          organisationId_userId: {
            organisationId: actor.organisationId,
            userId: appointment.doctorUserId,
          },
        },
      });
      const name =
        appointment.doctorUserId === actor.userId
          ? doctorName
          : await this.doctorName(appointment.doctorUserId);
      const doc = await loadDocument(
        tx,
        this.s.cipher,
        row,
        { name, profile },
        {
          watermark: 'preview',
          number: null,
          signature: null,
          verificationUrl: null,
          amendmentDate: row.amendsPrescriptionId ? istDate(this.s.now()) : null,
        },
      );
      await auditVisit(tx, request, actor, 'prescription.previewed', appointmentId, {
        prescriptionId: row.id,
      });
      return renderPrescriptionPdf(doc);
    });
  }

  /**
   * Signs the draft the doctor reviewed (same revision). The PIN is checked first, in its
   * own transaction; then, under the visit lock: the profile and verification, the safety
   * check again (no open blocks or warnings), the number, the PDF, the signature and the
   * stored file. The previous version, if this is an amendment, becomes superseded, and
   * the visit record locks.
   */
  async sign(
    request: FastifyRequest,
    actor: Actor,
    appointmentId: string,
    body: SignPrescriptionBody,
  ): Promise<Prescription> {
    const signer = this.s.signer;
    if (!signer) {
      throw new AppError(503, 'SIGNING_UNAVAILABLE', 'Signing is not set up on this server yet.');
    }
    await this.profiles.checkPin(request, actor, body.pin);
    const doctorName = await this.doctorName(actor.userId);
    const doctor = { userId: actor.userId, name: doctorName };

    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      const { appointment, existing, consultation } = await writableVisit(tx, actor, appointmentId);
      if (!existing || existing.items.length === 0) {
        throw new AppError(422, 'BUSINESS_RULE', 'Add at least one medicine before signing.');
      }
      if (existing.revision !== body.revision) {
        throw new AppError(
          409,
          'CONFLICT',
          'The prescription changed since you reviewed it. Check it again before signing.',
          { revision: 'stale' },
        );
      }
      const profile = await findProfile(tx, actor);
      const gaps = signingGaps(profile, true);
      if (gaps.includes('verification')) {
        throw new AppError(
          403,
          'DOCTOR_NOT_VERIFIED',
          'Your registration is waiting for verification by the platform team.',
        );
      }
      if (gaps.length > 0 || !profile) {
        throw new AppError(422, 'BUSINESS_RULE', 'Complete your prescription pad details first.', {
          profile: 'incomplete',
        });
      }

      const { summary } = await checkAndRecord(tx, {
        visit: appointment,
        prescriptionId: existing.id,
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        items: existing.items,
        persist: true,
        now: this.s.now(),
      });
      if (summary.openBlocks > 0 || summary.openWarnings > 0) {
        throw new AppError(
          422,
          'SAFETY_BLOCK',
          'Resolve the safety alerts before signing: change the prescription, or answer each one.',
          { openBlocks: String(summary.openBlocks), openWarnings: String(summary.openWarnings) },
        );
      }

      const previous = existing.amendsPrescriptionId
        ? await tx.prescription.findUniqueOrThrow({ where: { id: existing.amendsPrescriptionId } })
        : null;
      if (previous && previous.status !== 'signed') {
        throw new AppError(409, 'CONFLICT', 'The version this amends is no longer current.');
      }
      let number = previous?.number ?? null;
      if (!number) {
        const counter = await tx.doctorProfile.update({
          where: { id: profile.id },
          data: { rxSequence: { increment: 1 } },
        });
        number = `${profile.rxPrefix}-${String(counter.rxSequence).padStart(5, '0')}`;
      }

      const signedAt = this.s.now();
      const code = verificationCode();
      const url = verificationUrl(this.s.webBaseUrl, code);
      const certificate = await signer.certificate(doctor);
      const paperSize = profile.paperSize;
      const doc = await loadDocument(
        tx,
        this.s.cipher,
        { ...existing, paperSize },
        { name: doctorName, profile },
        {
          watermark: null,
          number,
          signature: { signedAt, method: signer.method, certificate },
          verificationUrl: url,
          amendmentDate: previous ? istDate(signedAt) : null,
        },
      );
      const pdf = await renderPrescriptionPdf(doc);
      const digest = sha256(pdf);
      const signature = await signer.sign(digest, doctor);
      const key = `organisations/${actor.organisationId}/prescriptions/${existing.id}-v${existing.version}-${uniqueSuffix()}.pdf`;
      await this.s.files.put(key, pdf);

      await tx.prescription.update({
        where: { id: existing.id },
        data: {
          status: 'signed',
          number,
          signedAt,
          pdfFileKey: key,
          pdfSha256: digest.toString('hex'),
          templateVersion: PDF_TEMPLATE_VERSION,
          paperSize,
          signatureMethod: signer.method,
          signature,
          signerCertificate: certificate,
          verificationCode: code,
        },
      });
      await tx.prescriptionVerification.create({
        data: {
          codeHash: hashToken(code),
          organisationId: actor.organisationId,
          prescriptionId: existing.id,
        },
      });
      if (previous) {
        await tx.prescription.update({
          where: { id: previous.id },
          data: { status: 'superseded', supersededAt: signedAt },
        });
      }
      // The visit record locks with the first signature (PRD §6.1).
      if (!consultation) {
        await tx.consultation.create({
          data: {
            organisationId: actor.organisationId,
            appointmentId,
            patientId: appointment.patientId,
            doctorUserId: appointment.doctorUserId,
            notesCipher: this.s.cipher.encrypt(JSON.stringify(ConsultationNotes.parse({}))),
            lockedAt: signedAt,
          },
        });
      } else if (!consultation.lockedAt) {
        await tx.consultation.update({
          where: { id: consultation.id },
          data: { lockedAt: signedAt },
        });
      }
      await auditVisit(tx, request, actor, 'prescription.signed', appointmentId, {
        prescriptionId: existing.id,
        version: existing.version,
        number,
        pdfSha256: digest.toString('hex'),
        signatureMethod: signer.method,
        templateVersion: PDF_TEMPLATE_VERSION,
        drugDatabaseVersion: summary.drugDatabaseVersion,
        ...(previous ? { supersedes: previous.id } : {}),
      });
      return prescriptionOut(
        (await currentPrescription(tx, appointmentId))!,
        summary,
        this.s.webBaseUrl,
      );
    });
  }

  /**
   * Starts the next version of the signed prescription, copying its lines, for the doctor
   * to correct and sign. The signed version stays genuine until the new one is signed.
   */
  async amend(
    request: FastifyRequest,
    actor: Actor,
    appointmentId: string,
    body: AmendPrescriptionBody,
  ): Promise<Prescription> {
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      const appointment = await lockVisit(tx, appointmentId);
      if (appointment.doctorUserId !== actor.userId) {
        throw new AppError(
          403,
          'FORBIDDEN',
          'Only the visit’s doctor can amend this prescription.',
        );
      }
      const latest = await currentPrescription(tx, appointmentId);
      if (!latest || latest.status !== 'signed') {
        throw new AppError(409, 'CONFLICT', 'Only a signed prescription can be amended.');
      }
      const draft = await tx.prescription.create({
        data: {
          organisationId: actor.organisationId,
          appointmentId,
          patientId: latest.patientId,
          doctorUserId: latest.doctorUserId,
          version: latest.version + 1,
          language: latest.language,
          amendsPrescriptionId: latest.id,
          amendmentReason: body.reason,
        },
      });
      await tx.prescriptionItem.createMany({
        data: latest.items.map(({ id: _id, prescriptionId: _p, steps, ...line }) => ({
          ...line,
          steps: steps as Prisma.InputJsonValue,
          id: randomUUID(),
          prescriptionId: draft.id,
        })),
      });
      const row = (await currentPrescription(tx, appointmentId))!;
      const { summary } = await checkAndRecord(tx, {
        visit: appointment,
        prescriptionId: row.id,
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        items: row.items,
        persist: true,
        now: this.s.now(),
      });
      await auditVisit(tx, request, actor, 'prescription.amendment_started', appointmentId, {
        prescriptionId: row.id,
        version: row.version,
        amends: latest.id,
      });
      return prescriptionOut(row, summary, this.s.webBaseUrl);
    });
  }

  /**
   * Voids the signed prescription with a reason and the PIN. The signed file is kept; a
   * copy stamped VOID is what is shown and printed from now on. A draft amendment must be
   * signed first (the visit then voids its newest version).
   */
  async void(
    request: FastifyRequest,
    actor: Actor,
    appointmentId: string,
    body: VoidPrescriptionBody,
  ): Promise<Prescription> {
    await this.profiles.checkPin(request, actor, body.pin);
    const doctorName = await this.doctorName(actor.userId);
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      const appointment = await lockVisit(tx, appointmentId);
      if (appointment.doctorUserId !== actor.userId) {
        throw new AppError(403, 'FORBIDDEN', 'Only the visit’s doctor can void this prescription.');
      }
      const latest = await currentPrescription(tx, appointmentId);
      if (!latest || latest.status !== 'signed') {
        throw new AppError(
          409,
          'CONFLICT',
          latest?.status === 'draft' && latest.amendsPrescriptionId
            ? 'Sign the amendment first; then void the newest version.'
            : 'Only a signed prescription can be voided.',
        );
      }
      const voidedAt = this.s.now();
      const signed = await this.readSigned(latest);
      const copy = await stampVoid(signed, {
        language: latest.language,
        paperSize: latest.paperSize ?? 'a5',
        number: latest.number!,
        version: latest.version,
        doctorName,
        date: istDate(voidedAt),
        reason: body.reason,
      });
      const key = `organisations/${actor.organisationId}/prescriptions/${latest.id}-v${latest.version}-void-${uniqueSuffix()}.pdf`;
      await this.s.files.put(key, copy);
      await tx.prescription.update({
        where: { id: latest.id },
        data: {
          status: 'void',
          voidedAt,
          voidedByUserId: actor.userId,
          voidReason: body.reason,
          voidPdfFileKey: key,
        },
      });
      await auditVisit(tx, request, actor, 'prescription.voided', appointmentId, {
        prescriptionId: latest.id,
        version: latest.version,
        number: latest.number,
      });
      const row = (await currentPrescription(tx, appointmentId))!;
      const { summary } = await checkAndRecord(tx, {
        visit: appointment,
        prescriptionId: row.id,
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        items: row.items,
        persist: false,
        now: voidedAt,
      });
      return prescriptionOut(row, summary, this.s.webBaseUrl);
    });
  }

  /**
   * A signed version's PDF for viewing and printing (doctors; front desk prints). After
   * voiding, the stamped copy. The stored file is checked against its recorded hash.
   */
  async pdf(
    request: FastifyRequest,
    actor: Actor,
    prescriptionId: string,
  ): Promise<{ file: Buffer; filename: string }> {
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      const row = await tx.prescription.findUnique({
        where: { id: prescriptionId },
        include: { items: true },
      });
      if (!row || row.status === 'draft') throw NOT_FOUND();
      // Front desk prints any signed prescription; a doctor needs the chart.
      if (row.doctorUserId !== actor.userId) await assertChartAccess(tx, actor, row.patientId);
      const file =
        row.status === 'void' && row.voidPdfFileKey
          ? await this.s.files.get(row.voidPdfFileKey)
          : await this.readSigned(row);
      await writeAudit(tx, request, {
        action: 'prescription.pdf_viewed',
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        entityType: 'prescription',
        entityId: row.id,
        metadata: { version: row.version, status: row.status },
      });
      const suffix = row.status === 'void' ? '-void' : '';
      return { file, filename: `${row.number}-v${row.version}${suffix}.pdf` };
    });
  }

  /**
   * The public check behind the QR (PRD §9.4): Genuine, Superseded or Void, with enough
   * to match the paper — the doctor, the clinic, the patient's initials, age and gender,
   * and the medicine names. No session; the code is the only key.
   */
  async verify(code: string): Promise<PrescriptionCheck> {
    const normalised = code.trim().toUpperCase();
    const lookup = await withAuth(this.s.db, (tx) =>
      tx.prescriptionVerification.findUnique({ where: { codeHash: hashToken(normalised) } }),
    );
    if (!lookup) throw BAD_CODE();
    const found = await withTenant(this.s.db, lookup.organisationId, async (tx) => {
      const row = await tx.prescription.findUnique({
        where: { id: lookup.prescriptionId },
        include: {
          items: { orderBy: { sortOrder: 'asc' } },
          appointment: { include: { patient: true, clinic: true } },
        },
      });
      if (!row || row.verificationCode !== normalised) return null;
      const latest = await tx.prescription.findFirst({
        where: { appointmentId: row.appointmentId, status: { in: ['signed', 'superseded'] } },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      const profile = await tx.doctorProfile.findUnique({
        where: {
          organisationId_userId: { organisationId: row.organisationId, userId: row.doctorUserId },
        },
      });
      return { row, latest, profile };
    });
    if (!found) throw BAD_CODE();
    const { row, latest, profile } = found;
    const patient = row.appointment.patient;
    const names = await staffNames(this.s.db, [row.doctorUserId]);
    const initials = patient.name
      .split(/\s+/)
      .filter(Boolean)
      .map((part) => `${[...part][0]!.toUpperCase()}.`)
      .join(' ');
    return {
      status:
        row.status === 'void' ? 'void' : row.status === 'superseded' ? 'superseded' : 'genuine',
      number: row.number!,
      version: row.version,
      latestVersion: row.status === 'superseded' ? (latest?.version ?? null) : null,
      signedAt: row.signedAt!.toISOString(),
      supersededAt: row.supersededAt?.toISOString() ?? null,
      voidedAt: row.voidedAt?.toISOString() ?? null,
      signatureMethod: row.signatureMethod as PrescriptionCheck['signatureMethod'],
      doctor: {
        name: names.get(row.doctorUserId) ?? null,
        qualifications: profile?.qualifications ?? null,
        registrationNumber: profile?.registrationNumber ?? null,
        council: profile?.council ?? null,
      },
      clinicName: row.appointment.clinic.name,
      patient: {
        initials,
        ageYears: patient.dob
          ? ageFrom(fromDbDate(patient.dob), fromDbDate(row.appointment.date)).years
          : null,
        gender: patient.gender,
      },
      medicines: row.items.map((i) => ({ name: i.name, generic: i.composition })),
    };
  }

  // ---- Helpers ----------------------------------------------------------------------

  /** The signed file, refusing to serve one that does not match its recorded hash. */
  private async readSigned(row: Pick<PrescriptionRow, 'id' | 'pdfFileKey' | 'pdfSha256'>) {
    const file = await this.s.files.get(row.pdfFileKey!);
    if (sha256(file).toString('hex') !== row.pdfSha256) {
      throw new Error(`Stored PDF for prescription ${row.id} does not match its hash`);
    }
    return file;
  }

  private async doctorName(userId: string): Promise<string> {
    return (await staffNames(this.s.db, [userId])).get(userId) ?? 'Doctor';
  }
}
