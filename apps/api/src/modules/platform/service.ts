import {
  MAX_USAGE_DAYS,
  PLATFORM_DOCTOR_PAGE,
  type CreatePlatformOrganisationBody,
  type CreatedPlatformOrganisation,
  type PlatformDoctor,
  type PlatformMeResponse,
  type PlatformOrganisation,
  type PlatformUsageQuery,
  type PlatformUsageReport,
  type VerifiedPlatformDoctor,
  type VerifyPlatformDoctorBody,
} from '@dhc/contracts';
import { withAuth, withNewOrganisation, withPlatform, type Tx } from '@dhc/db';
import { addDays, istDateKey } from '@dhc/domain';
import type { FastifyRequest } from 'fastify';
import type { PlatformAccessClaims } from '../../auth/tokens';
import { AppError } from '../../errors';
import type { Services } from '../../services';
import { writeAudit, type AuditSource } from '../audit/write';
import {
  findOrCreateInvitee,
  issueJoinInvite,
  maskIdentifier,
  parseIdentifier,
} from '../invites/service';
import { verifyDoctorProfile, type VerifyDoctorResult } from '../support/verify-doctor';

interface OrganisationSummaryRow {
  id: string;
  slug: string;
  name: string;
  status: 'active' | 'suspended';
  created_at: Date;
  clinics_active: number;
  clinics_total: number;
  doctors_active: number;
  doctors_invited: number;
  doctors_revoked: number;
  front_desk_active: number;
  front_desk_invited: number;
  front_desk_revoked: number;
  clinic_admins_active: number;
  clinic_admins_invited: number;
  clinic_admins_revoked: number;
  doctors_pending: number;
  doctors_verified: number;
}

interface DoctorProfileRow {
  profile_id: string;
  organisation_id: string;
  organisation_slug: string;
  organisation_name: string;
  user_id: string;
  display_name: string | null;
  identifier: string;
  registration_number: string | null;
  council: string | null;
  qualifications: string | null;
  specialty: string | null;
  verification: 'pending' | 'verified';
  submitted_at: Date;
  verified_at: Date | null;
  verified_by: string | null;
}

interface UsageRow {
  organisation_id: string;
  slug: string;
  name: string;
  status: 'active' | 'suspended';
  appointments: number;
  prescriptions: number;
  payments: number;
  payments_paise: bigint | number;
}

const PROFILE_NOT_FOUND = () =>
  new AppError(404, 'NOT_FOUND', 'No active doctor’s profile with that ID.');

/** A platform-level audit entry about what an operator did or looked at. */
async function auditOperator(
  tx: Tx,
  source: AuditSource,
  action: string,
  operatorId: string,
  metadata: Record<string, string | number>,
) {
  await writeAudit(tx, source, {
    action,
    organisationId: null,
    actorUserId: null,
    entityType: 'platform_operator',
    entityId: operatorId,
    metadata,
  });
}

/**
 * The platform console (PRD §9.3). Reads across organisations go only through the
 * `platform_*` database functions as `dhc_platform`, which return counts and doctors'
 * registration details; no patient or clinical row is ever read here (ADR 0016). Writes
 * into an organisation run as `dhc_app` inside it, as a clinic request would.
 */
export class PlatformService {
  constructor(private readonly s: Services) {}

  async me(claims: PlatformAccessClaims): Promise<PlatformMeResponse> {
    const operator = await this.operator(claims);
    return { operator };
  }

  async listOrganisations(
    request: FastifyRequest,
    claims: PlatformAccessClaims,
  ): Promise<PlatformOrganisation[]> {
    const rows = await withPlatform(this.s.db, async (tx) => {
      const rows = await tx.$queryRaw<OrganisationSummaryRow[]>`
        SELECT * FROM platform_organisation_summaries()`;
      await auditOperator(tx, request, 'platform.organisations.listed', claims.operatorId, {
        count: rows.length,
      });
      return rows;
    });
    return rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      status: r.status,
      createdAt: r.created_at.toISOString(),
      clinics: { active: r.clinics_active, total: r.clinics_total },
      staff: {
        doctor: {
          active: r.doctors_active,
          invited: r.doctors_invited,
          revoked: r.doctors_revoked,
        },
        frontDesk: {
          active: r.front_desk_active,
          invited: r.front_desk_invited,
          revoked: r.front_desk_revoked,
        },
        clinicAdmin: {
          active: r.clinic_admins_active,
          invited: r.clinic_admins_invited,
          revoked: r.clinic_admins_revoked,
        },
      },
      doctorVerification: { pending: r.doctors_pending, verified: r.doctors_verified },
    }));
  }

  /**
   * Onboarding steps 1–2 (PRD §9.1): the organisation, its first clinic and a join invite
   * for its first clinic admin, committed together. The invite URL is returned once.
   */
  async createOrganisation(
    request: FastifyRequest,
    claims: PlatformAccessClaims,
    body: CreatePlatformOrganisationBody,
  ): Promise<CreatedPlatformOrganisation> {
    const operator = await this.operator(claims);
    const identity = parseIdentifier(body.admin.identifier);
    const now = this.s.now();
    const by = { operatorId: operator.id, operator: operator.email };
    const slugTaken = async () => {
      await withPlatform(this.s.db, (tx) =>
        auditOperator(tx, request, 'platform.organisation.create_refused', operator.id, {
          reason: 'slug_taken',
          slug: body.slug,
        }),
      );
      return new AppError(409, 'CONFLICT', 'Another organisation already uses that ID.', {
        slug: 'taken',
      });
    };

    // Refuse a taken slug before creating the admin's account; the insert below checks
    // again, for two onboardings racing for one slug.
    const [{ taken } = { taken: false }] = await withPlatform(
      this.s.db,
      (tx) => tx.$queryRaw<{ taken: boolean }[]>`
        SELECT platform_organisation_slug_taken(${body.slug}) AS taken`,
    );
    if (taken) throw await slugTaken();
    const user = await withAuth(this.s.db, (tx) =>
      findOrCreateInvitee(tx, identity, body.admin.displayName),
    );

    const created = await withNewOrganisation(
      this.s.db,
      { slug: body.slug, name: body.name, now },
      async (tx, organisationId) => {
        await writeAudit(tx, request, {
          action: 'platform.organisation.created',
          organisationId,
          actorUserId: null,
          entityType: 'organisation',
          entityId: organisationId,
          metadata: { ...by, slug: body.slug },
        });
        const clinic = await tx.clinic.create({
          data: {
            organisationId,
            name: body.clinic.name,
            address: body.clinic.address || null,
            phone: body.clinic.phone || null,
          },
        });
        await writeAudit(tx, request, {
          action: 'clinic.created',
          organisationId,
          actorUserId: null,
          entityType: 'clinic',
          entityId: clinic.id,
          metadata: by,
        });
        // No clinic user issued this link: the invitee stands in as creator (as for support
        // resets) and the audit entry names the operator.
        const { invite, inviteUrl } = await issueJoinInvite(tx, request, this.s, {
          organisationId,
          user,
          role: 'clinic_admin',
          now,
          createdByUserId: user.id,
          actorUserId: null,
          metadata: by,
        });
        return { organisationId, clinic, invite, inviteUrl };
      },
    );
    if (!created) throw await slugTaken();
    // The operator's own trail, beside the entry in the organisation's log.
    await withPlatform(this.s.db, (tx) =>
      auditOperator(tx, request, 'platform.organisation.created', operator.id, {
        organisationId: created.organisationId,
        slug: body.slug,
      }),
    );
    return {
      organisation: { id: created.organisationId, slug: body.slug, name: body.name },
      clinic: { id: created.clinic.id, name: created.clinic.name },
      invite: {
        id: created.invite.id,
        role: 'clinic_admin',
        identifier: maskIdentifier(user.email ?? user.phone ?? ''),
        expiresAt: created.invite.expiresAt.toISOString(),
        inviteUrl: created.inviteUrl,
      },
    };
  }

  /** The verification queue: active doctors' profiles, oldest submission first. */
  async listDoctors(
    request: FastifyRequest,
    claims: PlatformAccessClaims,
    status: 'pending' | 'verified',
  ): Promise<{ data: PlatformDoctor[]; hasMore: boolean }> {
    const rows = await withPlatform(this.s.db, async (tx) => {
      // One more than a page, to tell whether more wait.
      const rows = await this.doctorRows(tx, { status }, PLATFORM_DOCTOR_PAGE + 1);
      await auditOperator(tx, request, 'platform.doctors.listed', claims.operatorId, {
        status,
        count: Math.min(rows.length, PLATFORM_DOCTOR_PAGE),
      });
      return rows;
    });
    return {
      data: rows.slice(0, PLATFORM_DOCTOR_PAGE).map(toPlatformDoctor),
      hasMore: rows.length > PLATFORM_DOCTOR_PAGE,
    };
  }

  /**
   * Verifies a doctor's registration from the console: the same change and audit entry
   * (`support.doctor.verified`) as the support command, with the signed-in operator. Only
   * the registration the operator was shown (`expected`) is verified.
   */
  async verifyDoctor(
    request: FastifyRequest,
    claims: PlatformAccessClaims,
    profileId: string,
    body: VerifyPlatformDoctorBody,
  ): Promise<VerifiedPlatformDoctor> {
    const operator = await this.operator(claims);
    const audit = (action: string, metadata: Record<string, string>) =>
      withPlatform(this.s.db, (tx) =>
        auditOperator(tx, request, action, operator.id, {
          profileId,
          ticket: body.ticket,
          ...metadata,
        }),
      );
    const [row] = await withPlatform(this.s.db, (tx) => this.doctorRows(tx, { profileId }, 1));
    if (!row) {
      await audit('platform.doctor.verify_refused', { reason: 'not_found' });
      throw PROFILE_NOT_FOUND();
    }
    let result: VerifyDoctorResult;
    try {
      result = await verifyDoctorProfile(
        this.s,
        request,
        { organisationId: row.organisation_id, userId: row.user_id },
        { ticket: body.ticket, operator: operator.email, operatorId: operator.id },
        {
          expected: {
            registrationNumber: body.expected.registrationNumber,
            council: body.expected.council,
            submittedAt: new Date(body.expected.submittedAt),
          },
        },
      );
      // The profile the queue showed must be the one verified.
      if (result.profileId !== profileId) throw PROFILE_NOT_FOUND();
    } catch (error) {
      if (error instanceof AppError) {
        await audit('platform.doctor.verify_refused', {
          organisationId: row.organisation_id,
          reason: error.fields?.profile ?? error.code.toLowerCase(),
        });
      }
      throw error;
    }
    if (!result.alreadyVerified) {
      await audit('platform.doctor.verified', {
        organisationId: row.organisation_id,
        registrationNumber: result.registrationNumber,
      });
    }
    // From the verifying transaction's own read: a change a moment later cannot alter it.
    return {
      profileId: result.profileId,
      organisation: result.organisation,
      displayName: result.displayName,
      identifier: result.identifier,
      registrationNumber: result.registrationNumber,
      council: result.council,
      qualifications: result.qualifications,
      specialty: result.specialty,
      verification: result.verification,
      submittedAt: result.submittedAt.toISOString(),
      verifiedAt: result.verifiedAt?.toISOString() ?? null,
      verifiedBy: result.verifiedBy,
      alreadyVerified: result.alreadyVerified,
    };
  }

  /** Usage per organisation over IST days (default: the last 30 days). Counts only. */
  async usage(
    request: FastifyRequest,
    claims: PlatformAccessClaims,
    query: PlatformUsageQuery,
  ): Promise<PlatformUsageReport> {
    const to = query.to ?? istDateKey(this.s.now());
    const from = query.from ?? addDays(to, -29);
    if (from > to || addDays(from, MAX_USAGE_DAYS) <= to) {
      throw new AppError(
        400,
        'VALIDATION_FAILED',
        `Pick a start on or before the end, at most ${MAX_USAGE_DAYS} days in all.`,
        { from: 'invalid' },
      );
    }
    const rows = await withPlatform(this.s.db, async (tx) => {
      const rows = await tx.$queryRaw<UsageRow[]>`
        SELECT * FROM platform_usage(${from}::date, ${to}::date)`;
      await auditOperator(tx, request, 'platform.usage.viewed', claims.operatorId, { from, to });
      return rows;
    });
    return {
      from,
      to,
      data: rows.map((r) => ({
        organisation: { id: r.organisation_id, slug: r.slug, name: r.name, status: r.status },
        appointments: r.appointments,
        prescriptions: r.prescriptions,
        payments: { count: r.payments, amountPaise: Number(r.payments_paise) },
        // Not built yet (messaging, AI scribe): null rather than a misleading zero.
        messages: null,
        scribeMinutes: null,
      })),
    };
  }

  private async doctorRows(
    tx: Tx,
    by: { status: 'pending' | 'verified' } | { profileId: string },
    limit: number,
  ): Promise<DoctorProfileRow[]> {
    const status = 'status' in by ? by.status : null;
    const profileId = 'profileId' in by ? by.profileId : null;
    return tx.$queryRaw<DoctorProfileRow[]>`
      SELECT * FROM platform_doctor_profiles(${status}::text, ${profileId}::uuid, ${limit}::int)`;
  }

  private async operator(claims: PlatformAccessClaims) {
    const operator = await withPlatform(this.s.db, (tx) =>
      tx.platformOperator.findUnique({
        where: { id: claims.operatorId },
        select: { id: true, email: true, displayName: true },
      }),
    );
    if (!operator) throw new AppError(401, 'UNAUTHENTICATED', 'Please sign in again.');
    return operator;
  }
}

function toPlatformDoctor(r: DoctorProfileRow): PlatformDoctor {
  return {
    profileId: r.profile_id,
    organisation: { id: r.organisation_id, slug: r.organisation_slug, name: r.organisation_name },
    displayName: r.display_name,
    identifier: r.identifier,
    registrationNumber: r.registration_number,
    council: r.council,
    qualifications: r.qualifications,
    specialty: r.specialty,
    verification: r.verification,
    submittedAt: r.submitted_at.toISOString(),
    verifiedAt: r.verified_at?.toISOString() ?? null,
    verifiedBy: r.verified_by,
  };
}
