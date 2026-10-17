import { withAuth, withTenant } from '@dhc/db';
import { AppError } from '../../errors';
import type { Services } from '../../services';
import { writeAudit, type AuditSource } from '../audit/write';
import { maskIdentifier, parseIdentifier } from '../invites/service';

/** The registration details the operator checked, as they were shown. */
export interface ExpectedRegistration {
  registrationNumber: string;
  council: string;
  /** When the profile entered the queue; a new registration number or council changes it. */
  submittedAt: Date;
}

export interface VerifyDoctorParams {
  /** The doctor's email address or mobile number. */
  identifier: string;
  /** Slug of the clinic whose profile is being verified. */
  clinic: string;
  /** Support ticket recording the registration check (council register, certificate). */
  ticket: string;
  operator: string;
  dryRun?: boolean;
  /** What the dry run showed: refuse if the profile changed since. */
  expected?: ExpectedRegistration;
}

export interface VerifyDoctorResult {
  profileId: string;
  displayName: string | null;
  identifier: string;
  clinic: string;
  organisation: { id: string; slug: string; name: string };
  registrationNumber: string;
  council: string;
  qualifications: string;
  specialty: string | null;
  submittedAt: Date;
  verification: 'pending' | 'verified';
  verifiedAt: Date | null;
  verifiedBy: string | null;
  alreadyVerified: boolean;
  dryRun: boolean;
}

/** Who verified: the support ticket and the operator, as recorded on the profile and audit. */
export interface Verifier {
  ticket: string;
  /** Name or email; the console uses the signed-in operator's email. */
  operator: string;
  /** The platform operator's ID, when verified from the console. */
  operatorId?: string;
}

const invalid = (field: string, message: string) =>
  new AppError(400, 'VALIDATION_FAILED', message, { [field]: 'invalid' });

/** The doctor changed their registration after it was shown: it has not been checked. */
export const PROFILE_CHANGED = () =>
  new AppError(
    409,
    'CONFLICT',
    'The doctor’s registration details changed after they were shown. Reload and check them again.',
    { profile: 'changed' },
  );

const NO_DOCTOR = () =>
  new AppError(404, 'NOT_FOUND', 'No active doctor with that email or mobile at that clinic.');

function checkVerifier(verifier: Verifier): Verifier {
  const ticket = verifier.ticket.trim();
  const operator = verifier.operator.trim();
  if (!/^[A-Za-z0-9._-]{3,40}$/.test(ticket)) {
    throw invalid('ticket', 'Give the support ticket ID (3–40 letters, digits, . _ -).');
  }
  if (operator.length < 3 || operator.length > 80) {
    throw invalid('operator', 'Give the operator’s name or email (3–80 characters).');
  }
  return { ...verifier, ticket, operator };
}

/**
 * Platform verification of a doctor's registration (PRD §9.1 step 4): unverified doctors
 * cannot sign. Run through the support command after checking the council register
 * (docs/runbooks/doctor-verification.md) when the platform console cannot be used.
 */
export async function supportVerifyDoctor(
  s: Pick<Services, 'db' | 'now'>,
  source: AuditSource,
  params: VerifyDoctorParams,
): Promise<VerifyDoctorResult> {
  const verifier = checkVerifier(params);
  const identity = parseIdentifier(params.identifier);
  const slug = params.clinic.trim().toLowerCase();

  const found = await withAuth(s.db, async (tx) => {
    const user = await tx.user.findFirst({ where: identity, select: { id: true } });
    const organisation = await tx.organisation.findUnique({ where: { slug } });
    return user && organisation ? { userId: user.id, organisationId: organisation.id } : null;
  });
  if (!found) throw NO_DOCTOR();
  return verifyDoctorProfile(s, source, found, verifier, {
    dryRun: Boolean(params.dryRun),
    expected: params.expected,
  });
}

/**
 * Marks one doctor's profile in one organisation verified: the same effect and audit entry
 * (`support.doctor.verified`) whether the support command or the platform console asks.
 * The write runs inside that organisation, under its row-level security. With `expected`,
 * it verifies only the registration the operator was shown: if the doctor changed it
 * meanwhile, even while this runs, nothing changes and it answers 409 `profile: changed`.
 */
export async function verifyDoctorProfile(
  s: Pick<Services, 'db' | 'now'>,
  source: AuditSource,
  target: { organisationId: string; userId: string },
  rawVerifier: Verifier,
  { dryRun = false, expected }: { dryRun?: boolean; expected?: ExpectedRegistration } = {},
): Promise<VerifyDoctorResult> {
  const { ticket, operator, operatorId } = checkVerifier(rawVerifier);

  const found = await withAuth(s.db, async (tx) => {
    const membership = await tx.membership.findFirst({
      where: { ...target, role: 'doctor', status: 'active' },
      select: { id: true },
    });
    if (!membership) return null;
    const user = await tx.user.findUnique({
      where: { id: target.userId },
      select: { email: true, phone: true, displayName: true },
    });
    const organisation = await tx.organisation.findUnique({
      where: { id: target.organisationId },
      select: { id: true, slug: true, name: true },
    });
    return user && organisation ? { user, organisation } : null;
  });
  if (!found) throw NO_DOCTOR();
  const { user, organisation } = found;

  return withTenant(s.db, target.organisationId, async (tx) => {
    const profile = await tx.doctorProfile.findUnique({
      where: { organisationId_userId: target },
    });
    if (!profile?.registrationNumber || !profile.council || !profile.qualifications) {
      throw new AppError(
        422,
        'BUSINESS_RULE',
        'The doctor has not filled in their registration number, council and qualifications yet.',
      );
    }
    if (
      expected &&
      (expected.registrationNumber !== profile.registrationNumber ||
        expected.council !== profile.council ||
        expected.submittedAt.getTime() !== profile.submittedAt.getTime())
    ) {
      throw PROFILE_CHANGED();
    }
    const result: VerifyDoctorResult = {
      profileId: profile.id,
      displayName: user.displayName,
      identifier: maskIdentifier(user.email ?? user.phone ?? ''),
      clinic: organisation.slug,
      organisation,
      registrationNumber: profile.registrationNumber,
      council: profile.council,
      qualifications: profile.qualifications,
      specialty: profile.specialty,
      submittedAt: profile.submittedAt,
      verification: profile.verification,
      verifiedAt: profile.verifiedAt,
      verifiedBy: profile.verifiedBy,
      alreadyVerified: profile.verification === 'verified',
      dryRun,
    };
    if (dryRun || result.alreadyVerified) return result;
    const verifiedAt = s.now();
    const verifiedBy = `${operator} (${ticket})`;
    // Conditional: a save of new registration details that commits after the read above
    // no longer matches, so an unchecked registration is never marked verified.
    const updated = await tx.doctorProfile.updateMany({
      where: {
        id: profile.id,
        verification: 'pending',
        registrationNumber: profile.registrationNumber,
        council: profile.council,
        submittedAt: profile.submittedAt,
      },
      data: { verification: 'verified', verifiedAt, verifiedBy },
    });
    if (updated.count !== 1) throw PROFILE_CHANGED();
    await writeAudit(tx, source, {
      action: 'support.doctor.verified',
      organisationId: target.organisationId,
      actorUserId: null,
      entityType: 'doctor_profile',
      entityId: profile.id,
      metadata: {
        ticket,
        operator,
        registrationNumber: profile.registrationNumber,
        ...(operatorId ? { operatorId } : {}),
      },
    });
    return { ...result, verification: 'verified', verifiedAt, verifiedBy };
  });
}
