import { STAFF_ROLES, type StaffRole } from '@dhc/contracts';
import { withAuth, withTenant } from '@dhc/db';
import { randomBytes } from 'node:crypto';
import { hashToken } from '../../auth/tokens';
import { AppError } from '../../errors';
import type { Services } from '../../services';
import { writeAudit, type AuditSource } from '../audit/write';
import { INVITE_TTL_MS, maskIdentifier, parseIdentifier } from '../invites/service';

const STAFF = [...STAFF_ROLES];

export interface SupportResetParams {
  /** The person's email address or mobile number. */
  identifier: string;
  /** Slug of the clinic the setup link opens into. Must be one of theirs. */
  clinic: string;
  /** Support ticket that records the request, identity check and approval. */
  ticket: string;
  /** Who is running the reset. */
  operator: string;
  reason: string;
  /** Report what would happen without changing anything. */
  dryRun?: boolean;
}

export interface SupportResetResult {
  userId: string;
  displayName: string | null;
  identifier: string;
  clinics: { slug: string; name: string; roles: StaffRole[] }[];
  linkClinic: string;
  /** Only when not a dry run. */
  inviteUrl?: string;
  expiresAt?: string;
  sessionsRevoked: number;
  invitesRevoked: number;
  dryRun: boolean;
}

const invalid = (field: string, message: string) =>
  new AppError(400, 'VALIDATION_FAILED', message, { [field]: 'invalid' });

/**
 * Platform-support reset of a staff member's password and authenticator, for people a
 * clinic admin may not reset because they also work at another clinic (threat model T22).
 * Run through the support command (docs/runbooks/support-authenticator-reset.md), never
 * from a clinic's own session.
 *
 * Clears the credentials and signs the person out of every staff session at every clinic,
 * revokes their open invite links everywhere, and issues one reset link for the chosen
 * clinic. Completing it restores sign-in for all their clinics, because the authenticator
 * belongs to the person. Every clinic they work at gets an audit entry naming the ticket.
 */
export async function supportResetAuthenticator(
  s: Pick<Services, 'db' | 'webBaseUrl' | 'now'>,
  source: AuditSource,
  params: SupportResetParams,
): Promise<SupportResetResult> {
  const ticket = params.ticket.trim();
  const operator = params.operator.trim();
  const reason = params.reason.trim();
  if (!/^[A-Za-z0-9._-]{3,40}$/.test(ticket)) {
    throw invalid('ticket', 'Give the support ticket ID (3–40 letters, digits, . _ -).');
  }
  if (operator.length < 3 || operator.length > 80) {
    throw invalid('operator', 'Give the operator’s name or email (3–80 characters).');
  }
  if (reason.length < 10 || reason.length > 500) {
    throw invalid('reason', 'Give a reason of 10–500 characters.');
  }
  const identity = parseIdentifier(params.identifier);
  const now = s.now();

  // Identity and memberships across clinics live behind the sign-in role.
  const found = await withAuth(s.db, async (tx) => {
    const user = await tx.user.findFirst({
      where: identity,
      select: { id: true, email: true, phone: true, displayName: true },
    });
    if (!user) return null;
    const memberships = await tx.membership.findMany({
      where: { userId: user.id, role: { in: STAFF }, status: 'active' },
      select: {
        role: true,
        organisationId: true,
        organisation: { select: { slug: true, name: true, status: true } },
      },
    });
    const openInvites = await tx.staffInvite.findMany({
      where: { userId: user.id, acceptedAt: null, revokedAt: null },
      select: { organisationId: true },
    });
    return { user, memberships, openInvites };
  });
  if (!found || found.memberships.length === 0) {
    throw new AppError(404, 'NOT_FOUND', 'No active staff member with that email or mobile.');
  }
  const { user, memberships } = found;

  const clinicsById = new Map<string, SupportResetResult['clinics'][number]>();
  for (const m of memberships) {
    const clinic = clinicsById.get(m.organisationId) ?? {
      slug: m.organisation.slug,
      name: m.organisation.name,
      roles: [],
    };
    clinic.roles.push(m.role as StaffRole);
    clinicsById.set(m.organisationId, clinic);
  }
  const link = [...clinicsById].find(([, c]) => c.slug === params.clinic.trim().toLowerCase());
  if (!link) {
    throw invalid(
      'clinic',
      `The link must open into one of this person’s clinics: ${[...clinicsById.values()]
        .map((c) => c.slug)
        .sort()
        .join(', ')}.`,
    );
  }
  const [linkOrgId, linkClinic] = link;
  const inviteOrgIds = [...new Set(found.openInvites.map((i) => i.organisationId))];

  const result: SupportResetResult = {
    userId: user.id,
    displayName: user.displayName,
    identifier: maskIdentifier(user.email ?? user.phone ?? ''),
    clinics: [...clinicsById.values()].sort((a, b) => a.slug.localeCompare(b.slug)),
    linkClinic: linkClinic.slug,
    sessionsRevoked: 0,
    invitesRevoked: found.openInvites.length,
    dryRun: Boolean(params.dryRun),
  };
  if (params.dryRun) {
    result.sessionsRevoked = await withAuth(s.db, (tx) =>
      tx.session.count({ where: { userId: user.id, revokedAt: null, role: { not: 'patient' } } }),
    );
    return result;
  }

  const metadata = { ticket, operator, reason, linkClinic: linkClinic.slug };
  result.sessionsRevoked = await withAuth(s.db, async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: {
        passwordHash: null,
        mfaSecret: null,
        mfaPendingSecret: null,
        mfaLastUsedStep: null,
        failedLoginCount: 0,
        lockedUntil: null,
      },
    });
    const revoked = await tx.session.updateMany({
      where: { userId: user.id, revokedAt: null, role: { not: 'patient' } },
      data: { revokedAt: now, revokedReason: 'support_authenticator_reset' },
    });
    // Each clinic sees in its own audit log that support reset one of its staff.
    for (const organisationId of clinicsById.keys()) {
      await writeAudit(tx, source, {
        action: 'support.authenticator.reset',
        organisationId,
        actorUserId: null,
        entityType: 'user',
        entityId: user.id,
        metadata: { ...metadata, sessionsRevoked: revoked.count },
      });
    }
    return revoked.count;
  });

  // With no password set, any open link would let its holder choose one: only the new
  // link may work.
  for (const organisationId of inviteOrgIds) {
    await withTenant(s.db, organisationId, (tx) =>
      tx.staffInvite.updateMany({
        where: { userId: user.id, acceptedAt: null, revokedAt: null },
        data: { revokedAt: now },
      }),
    );
  }

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);
  await withTenant(s.db, linkOrgId, async (tx) => {
    const created = await tx.staffInvite.create({
      data: {
        organisationId: linkOrgId,
        userId: user.id,
        role: linkClinic.roles[0]!,
        purpose: 'reset',
        tokenHash: hashToken(token),
        // No clinic user issued this link; the audit entry names the support operator.
        createdByUserId: user.id,
        expiresAt,
        createdAt: now,
      },
    });
    await writeAudit(tx, source, {
      action: 'support.reset.link_created',
      organisationId: linkOrgId,
      actorUserId: null,
      entityType: 'staff_invite',
      entityId: created.id,
      metadata: { ...metadata, targetUserId: user.id },
    });
  });

  return {
    ...result,
    inviteUrl: `${s.webBaseUrl}/invite#${token}`,
    expiresAt: expiresAt.toISOString(),
  };
}
