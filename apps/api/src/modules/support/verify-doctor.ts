import { withAuth, withTenant } from '@dhc/db';
import { AppError } from '../../errors';
import type { Services } from '../../services';
import { writeAudit, type AuditSource } from '../audit/write';
import { maskIdentifier, parseIdentifier } from '../invites/service';

export interface VerifyDoctorParams {
  /** The doctor's email address or mobile number. */
  identifier: string;
  /** Slug of the clinic whose profile is being verified. */
  clinic: string;
  /** Support ticket recording the registration check (council register, certificate). */
  ticket: string;
  operator: string;
  dryRun?: boolean;
}

export interface VerifyDoctorResult {
  displayName: string | null;
  identifier: string;
  clinic: string;
  registrationNumber: string;
  council: string;
  qualifications: string;
  alreadyVerified: boolean;
  dryRun: boolean;
}

const invalid = (field: string, message: string) =>
  new AppError(400, 'VALIDATION_FAILED', message, { [field]: 'invalid' });

/**
 * Platform verification of a doctor's registration (PRD §9.1 step 4): unverified doctors
 * cannot sign. Run through the support command after checking the council register
 * (docs/runbooks/doctor-verification.md), until the platform console exists.
 */
export async function supportVerifyDoctor(
  s: Pick<Services, 'db' | 'now'>,
  source: AuditSource,
  params: VerifyDoctorParams,
): Promise<VerifyDoctorResult> {
  const ticket = params.ticket.trim();
  const operator = params.operator.trim();
  if (!/^[A-Za-z0-9._-]{3,40}$/.test(ticket)) {
    throw invalid('ticket', 'Give the support ticket ID (3–40 letters, digits, . _ -).');
  }
  if (operator.length < 3 || operator.length > 80) {
    throw invalid('operator', 'Give the operator’s name or email (3–80 characters).');
  }
  const identity = parseIdentifier(params.identifier);
  const slug = params.clinic.trim().toLowerCase();

  const found = await withAuth(s.db, async (tx) => {
    const user = await tx.user.findFirst({
      where: identity,
      select: { id: true, email: true, phone: true, displayName: true },
    });
    const organisation = await tx.organisation.findUnique({ where: { slug } });
    if (!user || !organisation) return null;
    const membership = await tx.membership.findFirst({
      where: { userId: user.id, organisationId: organisation.id, role: 'doctor', status: 'active' },
    });
    return membership ? { user, organisation } : null;
  });
  if (!found) {
    throw new AppError(
      404,
      'NOT_FOUND',
      'No active doctor with that email or mobile at that clinic.',
    );
  }
  const { user, organisation } = found;

  return withTenant(s.db, organisation.id, async (tx) => {
    const profile = await tx.doctorProfile.findUnique({
      where: { organisationId_userId: { organisationId: organisation.id, userId: user.id } },
    });
    if (!profile?.registrationNumber || !profile.council || !profile.qualifications) {
      throw new AppError(
        422,
        'BUSINESS_RULE',
        'The doctor has not filled in their registration number, council and qualifications yet.',
      );
    }
    const result: VerifyDoctorResult = {
      displayName: user.displayName,
      identifier: maskIdentifier(user.email ?? user.phone ?? ''),
      clinic: organisation.slug,
      registrationNumber: profile.registrationNumber,
      council: profile.council,
      qualifications: profile.qualifications,
      alreadyVerified: profile.verification === 'verified',
      dryRun: Boolean(params.dryRun),
    };
    if (params.dryRun || result.alreadyVerified) return result;
    await tx.doctorProfile.update({
      where: { id: profile.id },
      data: {
        verification: 'verified',
        verifiedAt: s.now(),
        verifiedBy: `${operator} (${ticket})`,
      },
    });
    await writeAudit(tx, source, {
      action: 'support.doctor.verified',
      organisationId: organisation.id,
      actorUserId: null,
      entityType: 'doctor_profile',
      entityId: profile.id,
      metadata: { ticket, operator, registrationNumber: profile.registrationNumber },
    });
    return result;
  });
}
