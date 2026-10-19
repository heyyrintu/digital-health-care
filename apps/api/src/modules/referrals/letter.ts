import {
  ConsultationNotes,
  type Language,
  type Referral,
  type ReferralLetterCheck,
  type SignReferralLetterBody,
} from '@dhc/contracts';
import { withAuth, withTenant, type Tx } from '@dhc/db';
import { ageFrom } from '@dhc/domain';
import type { FastifyRequest } from 'fastify';
import { hashToken } from '../../auth/tokens';
import { istDate } from '../../documents/pdf-kit';
import { AppError } from '../../errors';
import { uniqueSuffix } from '../../files';
import type { Services } from '../../services';
import { writeAudit } from '../audit/write';
import { DoctorProfileService, findProfile, signingGaps } from '../doctors/service';
import { staffNames } from '../prescribing/shared';
import { initialsOf, sha256, verificationCode } from '../prescribing/signing';
import {
  LETTER_TEMPLATE_VERSION,
  renderReferralLetterPdf,
  type LetterDocument,
} from './letter-pdf';
import {
  findReferral,
  letterVerificationUrl,
  lockReferral,
  ReferralService,
  type Actor,
  type ReferralRow,
} from './service';

const NOT_FOUND = () => new AppError(404, 'NOT_FOUND', 'Not found.');
const BAD_CODE = () =>
  new AppError(
    404,
    'NOT_FOUND',
    'No referral letter matches this code. Check it was typed correctly.',
  );
const fromDbDate = (date: Date) => date.toISOString().slice(0, 10);

/**
 * The signed referral letter (PRD §7.2), with the prescription's signing machinery (ADR
 * 0008): preview → sign with the PIN → PDF from the versioned template → SHA-256 →
 * signature → stored by key → public QR check. Only the referring doctor signs, once,
 * while the referral is not closed, and only with a verified prescription pad; the letter
 * never changes afterwards. Both doctors download it; closing the referral leaves it valid.
 * Audited without patient data or the letter's text.
 */
export class ReferralLetterService {
  private readonly profiles: DoctorProfileService;
  private readonly referrals: ReferralService;

  constructor(private readonly s: Services) {
    this.profiles = new DoctorProfileService(s);
    this.referrals = new ReferralService(s);
  }

  /** The letter as it would print, marked PREVIEW, with no signature or QR. */
  async preview(
    request: FastifyRequest,
    actor: Actor,
    id: string,
    language: Language | undefined,
  ): Promise<Buffer> {
    const doctorName = await this.doctorName(actor.userId);
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      const row = await findReferral(tx, actor, id);
      assertSignable(row, actor);
      const profile = await findProfile(tx, actor);
      const doc = await this.load(tx, row, {
        language,
        doctor: { name: doctorName, profile },
        date: istDate(this.s.now()),
        signature: null,
        verificationUrl: null,
      });
      await this.audit(tx, request, actor, 'referral.letter_previewed', id, {
        language: doc.language,
      });
      return renderReferralLetterPdf(doc);
    });
  }

  /**
   * Signs the letter. Who may sign is checked first, so a refused request costs no PIN
   * attempt; then the PIN, in its own transactions (as for prescriptions); then, with the
   * referral locked: the same checks again, the pad and its verification, the PDF, its
   * hash and signature, the stored file, the letter and its QR lookup.
   */
  async sign(
    request: FastifyRequest,
    actor: Actor,
    id: string,
    body: SignReferralLetterBody,
  ): Promise<Referral> {
    const signer = this.s.signer;
    if (!signer) {
      throw new AppError(503, 'SIGNING_UNAVAILABLE', 'Signing is not set up on this server yet.');
    }
    await withTenant(this.s.db, actor.organisationId, async (tx) =>
      assertSignable(await findReferral(tx, actor, id), actor),
    );
    await this.profiles.checkPin(request, actor, body.pin);
    const doctorName = await this.doctorName(actor.userId);
    const doctor = { userId: actor.userId, name: doctorName };

    const row = await withTenant(this.s.db, actor.organisationId, async (tx) => {
      const referral = await lockReferral(tx, actor, id);
      assertSignable(referral, actor);
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

      const signedAt = this.s.now();
      const code = verificationCode();
      const certificate = await signer.certificate(doctor);
      const doc = await this.load(tx, referral, {
        language: body.language,
        doctor: { name: doctorName, profile },
        date: istDate(signedAt),
        signature: { signedAt, method: signer.method, certificate },
        verificationUrl: letterVerificationUrl(this.s.webBaseUrl, code),
      });
      const pdf = await renderReferralLetterPdf(doc);
      const digest = sha256(pdf);
      const signature = await signer.sign(digest, doctor);
      const key = `organisations/${actor.organisationId}/referrals/${id}-letter-${uniqueSuffix()}.pdf`;
      await this.s.files.put(key, pdf);

      const letter = await tx.referralLetter.create({
        data: {
          organisationId: actor.organisationId,
          referralId: id,
          signedByUserId: actor.userId,
          language: doc.language,
          paperSize: doc.paperSize,
          templateVersion: LETTER_TEMPLATE_VERSION,
          pdfFileKey: key,
          pdfSha256: digest.toString('hex'),
          signatureMethod: signer.method,
          signature,
          signerCertificate: certificate,
          verificationCode: code,
          signedAt,
        },
      });
      await tx.referralLetterVerification.create({
        data: {
          codeHash: hashToken(code),
          organisationId: actor.organisationId,
          referralLetterId: letter.id,
        },
      });
      await this.audit(tx, request, actor, 'referral.letter_signed', id, {
        letterId: letter.id,
        language: doc.language,
        paperSize: doc.paperSize,
        pdfSha256: digest.toString('hex'),
        signatureMethod: signer.method,
        templateVersion: LETTER_TEMPLATE_VERSION,
      });
      return findReferral(tx, actor, id);
    });
    return (await this.referrals.out([row], actor))[0]!;
  }

  /**
   * The signed letter, for the referring or the receiving doctor (anyone else, or a
   * referral without a letter, is 404), open or closed. The stored file is checked against
   * its recorded hash.
   */
  async pdf(
    request: FastifyRequest,
    actor: Actor,
    id: string,
  ): Promise<{ file: Buffer; filename: string }> {
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      const referral = await findReferral(tx, actor, id);
      const letter = await tx.referralLetter.findUnique({ where: { referralId: id } });
      if (!letter) throw NOT_FOUND();
      const file = await this.s.files.get(letter.pdfFileKey);
      if (sha256(file).toString('hex') !== letter.pdfSha256) {
        throw new Error(`Stored PDF for referral letter ${letter.id} does not match its hash`);
      }
      await this.audit(tx, request, actor, 'referral.letter_viewed', id, {
        letterId: letter.id,
        by: referral.referringDoctorUserId === actor.userId ? 'referring' : 'receiving',
      });
      return { file, filename: `referral-letter-${istDate(letter.signedAt)}.pdf` };
    });
  }

  /**
   * The public check behind the letter's QR: who signed it and when, the clinic, the
   * patient's initials, age and gender, the recipient, the urgency and the visit date.
   * No session; the code is the only key. No reason, notes or diagnoses.
   */
  async verify(code: string): Promise<ReferralLetterCheck> {
    const normalised = code.trim().toUpperCase();
    const lookup = await withAuth(this.s.db, (tx) =>
      tx.referralLetterVerification.findUnique({ where: { codeHash: hashToken(normalised) } }),
    );
    if (!lookup) throw BAD_CODE();
    const found = await withTenant(this.s.db, lookup.organisationId, async (tx) => {
      const letter = await tx.referralLetter.findUnique({
        where: { id: lookup.referralLetterId },
        include: {
          referral: {
            include: {
              appointment: { include: { clinic: true } },
              patient: { include: { mergedInto: true } },
            },
          },
        },
      });
      if (!letter || letter.verificationCode !== normalised) return null;
      const profiles = await tx.doctorProfile.findMany({
        where: {
          userId: {
            in: [letter.signedByUserId, letter.referral.receivingDoctorUserId].filter(
              (u): u is string => u !== null,
            ),
          },
        },
      });
      return { letter, profiles };
    });
    if (!found) throw BAD_CODE();
    const { letter, profiles } = found;
    const referral = letter.referral;
    const patient = referral.patient.mergedInto ?? referral.patient;
    const names = await staffNames(this.s.db, [
      letter.signedByUserId,
      ...(referral.receivingDoctorUserId ? [referral.receivingDoctorUserId] : []),
    ]);
    const profileOf = (userId: string) => profiles.find((p) => p.userId === userId) ?? null;
    const signer = profileOf(letter.signedByUserId);
    const visitDate = fromDbDate(referral.appointment.date);
    return {
      status: 'genuine',
      signedAt: letter.signedAt.toISOString(),
      signatureMethod: letter.signatureMethod as ReferralLetterCheck['signatureMethod'],
      doctor: {
        name: names.get(letter.signedByUserId) ?? null,
        qualifications: signer?.qualifications ?? null,
        registrationNumber: signer?.registrationNumber ?? null,
        council: signer?.council ?? null,
      },
      clinicName: referral.appointment.clinic.name,
      patient: {
        initials: initialsOf(patient.name),
        ageYears: patient.dob ? ageFrom(fromDbDate(patient.dob), visitDate).years : null,
        gender: patient.gender,
      },
      recipient: referral.receivingDoctorUserId
        ? {
            kind: 'internal',
            name: names.get(referral.receivingDoctorUserId) ?? null,
            specialty: profileOf(referral.receivingDoctorUserId)?.specialty ?? null,
            hospital: null,
          }
        : {
            kind: 'external',
            name: referral.externalName,
            specialty: referral.externalSpecialty,
            hospital: referral.externalHospital,
          },
      urgency: referral.urgency,
      visitDate,
    };
  }

  // ---- Helpers ----------------------------------------------------------------------

  /**
   * Reads what the letter prints inside the caller's tenant transaction: the visit, its
   * clinic, the organisation's branding name, the patient (the record in use after a
   * merge), the recipient and the visit's diagnoses from the doctor's notes (decrypted;
   * never the private notes).
   */
  private async load(
    tx: Tx,
    referral: ReferralRow,
    extra: {
      language: Language | undefined;
      doctor: {
        name: string;
        profile: {
          qualifications: string | null;
          specialty: string | null;
          registrationNumber: string | null;
          council: string | null;
          paperSize: 'a4' | 'a5';
        } | null;
      };
      date: string;
      signature: LetterDocument['signature'];
      verificationUrl: string | null;
    },
  ): Promise<LetterDocument> {
    const visit = await tx.appointment.findUniqueOrThrow({
      where: { id: referral.appointmentId },
      include: {
        clinic: true,
        consultation: true,
        organisation: { select: { name: true, branding: { select: { displayName: true } } } },
        patient: { include: { mergedInto: true } },
      },
    });
    const patient = visit.patient.mergedInto ?? visit.patient;
    const notes = visit.consultation
      ? ConsultationNotes.parse(JSON.parse(this.s.cipher.decrypt(visit.consultation.notesCipher)))
      : ConsultationNotes.parse({});
    const visitDate = fromDbDate(visit.date);
    let recipient: LetterDocument['recipient'];
    if (referral.receivingDoctorUserId) {
      const userId = referral.receivingDoctorUserId;
      const receiving = await tx.doctorProfile.findUnique({
        where: { organisationId_userId: { organisationId: referral.organisationId, userId } },
        select: { specialty: true },
      });
      recipient = {
        name: await this.doctorName(userId),
        specialty: receiving?.specialty ?? null,
        hospital: null,
        phone: null,
      };
    } else {
      recipient = {
        name: referral.externalName!,
        specialty: referral.externalSpecialty,
        hospital: referral.externalHospital,
        phone: referral.externalPhone,
      };
    }
    const profile = extra.doctor.profile;
    return {
      language: extra.language ?? patient.language,
      paperSize: profile?.paperSize ?? 'a5',
      watermark: extra.signature ? null : 'preview',
      doctor: {
        name: extra.doctor.name,
        qualifications: profile?.qualifications ?? null,
        specialty: profile?.specialty ?? null,
        registrationNumber: profile?.registrationNumber ?? null,
        council: profile?.council ?? null,
      },
      organisationName: visit.organisation.branding?.displayName ?? visit.organisation.name,
      clinic: { name: visit.clinic.name, address: visit.clinic.address, phone: visit.clinic.phone },
      date: extra.date,
      visitDate,
      patient: {
        name: patient.name,
        age: patient.dob ? ageFrom(fromDbDate(patient.dob), visitDate) : null,
        gender: patient.gender,
        uhid: patient.uhid,
      },
      recipient,
      urgency: referral.urgency,
      reason: referral.reason,
      notes: referral.notes,
      diagnoses: notes.diagnoses.map((d) => (d.code ? `${d.label} (${d.code})` : d.label)),
      signature: extra.signature,
      verificationUrl: extra.verificationUrl,
    };
  }

  private async doctorName(userId: string): Promise<string> {
    return (await staffNames(this.s.db, [userId])).get(userId) ?? 'Doctor';
  }

  private audit(
    tx: Tx,
    request: FastifyRequest,
    actor: Actor,
    action: string,
    referralId: string,
    metadata: Record<string, string>,
  ) {
    return writeAudit(tx, request, {
      action,
      organisationId: actor.organisationId,
      actorUserId: actor.userId,
      entityType: 'referral',
      entityId: referralId,
      metadata,
    });
  }
}

/**
 * Only the referring doctor signs (and previews) the letter, once, while the referral is
 * not closed. The receiving doctor is 403; anyone else already got 404.
 */
function assertSignable(row: ReferralRow, actor: Actor) {
  if (row.referringDoctorUserId !== actor.userId) {
    throw new AppError(403, 'FORBIDDEN', 'Only the referring doctor signs the referral letter.');
  }
  if (row.letter) {
    throw new AppError(409, 'CONFLICT', 'The referral letter is already signed.', {
      letter: 'signed',
    });
  }
  if (row.status === 'closed') {
    throw new AppError(
      409,
      'CONFLICT',
      'This referral is closed; a letter can no longer be signed.',
      {
        status: 'closed',
      },
    );
  }
}
