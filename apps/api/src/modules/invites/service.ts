import {
  NewPassword,
  type AcceptInviteResponse,
  type CreateStaffInviteBody,
  type CreatedStaffInvite,
  type InviteDetails,
  type StaffInvite,
  type StaffRole,
  type TokenResponse,
} from '@dhc/contracts';
import { Prisma, withAuth, withTenant, type Db, type Tx } from '@dhc/db';
import type { FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { hashPassword, verifyPassword } from '../../auth/password';
import { normaliseIndianMobile } from '../../auth/phone';
import { hashToken } from '../../auth/tokens';
import { generateTotpSecret, matchTotpStep, otpauthUri } from '../../auth/totp';
import { AppError } from '../../errors';
import type { Services } from '../../services';
import { writeAudit, type AuditSource } from '../audit/write';
import {
  AuthService,
  INVALID_CODE,
  LOCKED,
  STAFF_SESSION_MS,
  TOTP_ISSUER,
  recordFailure,
} from '../auth/service';

export const INVITE_TTL_MS = 72 * 3600_000;

/** The field-error code a new password that fails NewPassword gets. */
const WEAK_PASSWORD_CODE = 'too_weak';

/** The account was reset or finished enrolling while the password was being checked. */
const ACCOUNT_CHANGED = () =>
  new AppError(
    409,
    'CONFLICT',
    'Your account changed while this was being set up. Open the newest invite link you were sent.',
  );

const INVALID_INVITE = () =>
  new AppError(
    404,
    'NOT_FOUND',
    'This invite link is invalid or has expired. Ask your clinic admin for a new one.',
  );

interface Actor {
  userId: string;
  organisationId: string;
}

interface InviteRow {
  id: string;
  role: string;
  expiresAt: Date;
  createdAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
}

interface InviteeIdentity {
  email: string | null;
  phone: string | null;
  displayName: string | null;
}

/**
 * Staff invites: the clinic admin side and the person accepting. Completing an invite is
 * the only way to set a new staff account's password and enrol its authenticator.
 */
export class InviteService {
  private readonly auth: AuthService;

  constructor(private readonly s: Services) {
    this.auth = new AuthService(s);
  }

  // ---- Clinic admin ---------------------------------------------------------------

  async create(
    request: FastifyRequest,
    actor: Actor,
    body: CreateStaffInviteBody,
  ): Promise<CreatedStaffInvite> {
    const identity = parseIdentifier(body.identifier);
    const now = this.s.now();

    // Identity lives in platform-level tables (sign-in role); the invite and membership
    // live in the organisation (tenant role).
    const user = await inviteeAccount(this.s.db, identity, body.displayName);
    const { invite, inviteUrl } = await withTenant(this.s.db, actor.organisationId, (tx) =>
      issueJoinInvite(tx, request, this.s, {
        organisationId: actor.organisationId,
        user,
        role: body.role,
        now,
        createdByUserId: actor.userId,
        actorUserId: actor.userId,
      }),
    );
    return { ...toStaffInvite(invite, user, now), inviteUrl };
  }

  async list(actor: Actor): Promise<StaffInvite[]> {
    const now = this.s.now();
    const invites = await withTenant(this.s.db, actor.organisationId, (tx) =>
      tx.staffInvite.findMany({ orderBy: { createdAt: 'desc' }, take: 100 }),
    );
    const users = await withAuth(this.s.db, (tx) =>
      tx.user.findMany({
        where: { id: { in: [...new Set(invites.map((i) => i.userId))] } },
        select: { id: true, email: true, phone: true, displayName: true },
      }),
    );
    const byId = new Map(users.map((u) => [u.id, u]));
    return invites.map((invite) => toStaffInvite(invite, byId.get(invite.userId), now));
  }

  async revoke(request: FastifyRequest, actor: Actor, inviteId: string): Promise<void> {
    const now = this.s.now();
    await withTenant(this.s.db, actor.organisationId, async (tx) => {
      // Another organisation's invite is invisible here, so it reads as not found.
      const invite = await tx.staffInvite.findUnique({ where: { id: inviteId } });
      if (!invite) throw new AppError(404, 'NOT_FOUND', 'Not found.');
      if (invite.acceptedAt) {
        throw new AppError(409, 'CONFLICT', 'This invite has already been accepted.');
      }
      if (invite.revokedAt) return;
      await tx.staffInvite.update({ where: { id: invite.id }, data: { revokedAt: now } });
      await tx.membership.updateMany({
        where: {
          organisationId: invite.organisationId,
          userId: invite.userId,
          role: invite.role,
          status: 'invited',
        },
        data: { status: 'revoked' },
      });
      await writeAudit(tx, request, {
        action: 'staff.invite.revoked',
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        entityType: 'staff_invite',
        entityId: invite.id,
      });
    });
  }

  // ---- Person accepting the invite ------------------------------------------------

  async inspect(token: string): Promise<InviteDetails> {
    return withAuth(this.s.db, async (tx) => {
      const open = await this.openInvite(tx, token);
      if (!open) throw INVALID_INVITE();
      const { invite, organisation, user } = open;
      return {
        organisation: { name: organisation.name, slug: organisation.slug },
        role: invite.role as StaffRole,
        identifier: maskIdentifier(user.email ?? user.phone ?? ''),
        account: user.mfaSecret ? 'existing' : 'new',
        purpose: invite.purpose,
        expiresAt: invite.expiresAt.toISOString(),
      };
    });
  }

  async accept(
    request: FastifyRequest,
    token: string,
    password: string,
  ): Promise<AcceptInviteResponse> {
    const now = this.s.now();
    const found = await withAuth(this.s.db, async (tx) => {
      const open = await this.openInvite(tx, token);
      if (!open) return { error: INVALID_INVITE() };
      const { invite, user } = open;
      if (user.mfaSecret) {
        // Existing staff account (e.g. works at another clinic): prove it with the current
        // password here and the current authenticator in the next step.
        if (user.lockedUntil && user.lockedUntil > now) return { error: LOCKED() };
        return { inviteId: invite.id, existing: true as const, checkedHash: user.passwordHash };
      }
      const valid = NewPassword.safeParse(password);
      if (!valid.success) {
        const message = valid.error.issues[0]?.message ?? 'Choose a longer password.';
        return {
          error: new AppError(400, 'VALIDATION_FAILED', message, { password: WEAK_PASSWORD_CODE }),
        };
      }
      return { inviteId: invite.id, existing: false as const };
    });
    if ('error' in found) throw found.error;

    // scrypt runs between transactions: it is slow by design, and on a busy CPU it can
    // outlast the interactive-transaction timeout (a 500) while holding a pooled
    // connection. The second transaction re-reads everything it depends on.
    const passwordOk =
      found.existing && found.checkedHash
        ? await verifyPassword(password, found.checkedHash)
        : false;
    const newHash = found.existing ? null : await hashPassword(password);

    const outcome = await withAuth(this.s.db, async (tx) => {
      // The invite may have been used, revoked or expired meanwhile.
      const open = await this.openInvite(tx, token);
      if (!open || open.invite.id !== found.inviteId) return { error: INVALID_INVITE() };
      const { invite, user } = open;

      if (found.existing) {
        if (user.lockedUntil && user.lockedUntil > now) return { error: LOCKED() };
        // An admin reset the authenticator meanwhile: not a wrong password, so not counted.
        if (!user.mfaSecret) return { error: ACCOUNT_CHANGED() };
        // A password changed meanwhile counts as a wrong attempt.
        if (!passwordOk || user.passwordHash !== found.checkedHash) {
          await recordFailure(tx, user.id, now);
          await writeAudit(tx, request, {
            action: 'staff.invite.password_failed',
            organisationId: invite.organisationId,
            actorUserId: user.id,
            entityType: 'staff_invite',
            entityId: invite.id,
          });
          return { error: new AppError(401, 'UNAUTHENTICATED', 'Invalid sign-in details.') };
        }
        return { response: { status: 'confirm_required' as const } };
      }

      // Starting again from the link replaces an unfinished password and authenticator, but
      // never the password of an account that finished enrolling meanwhile.
      const secret = generateTotpSecret();
      const set = await tx.user.updateMany({
        where: { id: user.id, mfaSecret: null },
        data: { passwordHash: newHash, mfaPendingSecret: this.s.cipher.encrypt(secret) },
      });
      if (set.count !== 1) return { error: ACCOUNT_CHANGED() };
      const account = user.email ?? user.phone ?? user.id;
      return {
        response: {
          status: 'setup_required' as const,
          otpauthUri: otpauthUri(TOTP_ISSUER, account, secret),
        },
      };
    });
    if ('error' in outcome) throw outcome.error;
    return outcome.response;
  }

  async complete(request: FastifyRequest, token: string, code: string): Promise<TokenResponse> {
    const now = this.s.now();
    const outcome = await withAuth(this.s.db, async (tx) => {
      const open = await this.openInvite(tx, token);
      if (!open) return { error: INVALID_INVITE() };
      const { invite, user } = open;
      if (user.lockedUntil && user.lockedUntil > now) return { error: LOCKED() };

      const enrolling = !user.mfaSecret;
      const encrypted = user.mfaSecret ?? user.mfaPendingSecret;
      if (!encrypted || !user.passwordHash) {
        return { error: new AppError(409, 'CONFLICT', 'Set your password first.') };
      }

      const step = matchTotpStep(this.s.cipher.decrypt(encrypted), code, now.getTime());
      if (step === null || (user.mfaLastUsedStep !== null && step <= user.mfaLastUsedStep)) {
        await recordFailure(tx, user.id, now);
        await writeAudit(tx, request, {
          action: 'staff.invite.code_failed',
          organisationId: invite.organisationId,
          actorUserId: user.id,
          entityType: 'staff_invite',
          entityId: invite.id,
        });
        return { error: INVALID_CODE() };
      }

      // Conditional updates: a link completes once, even under concurrent requests.
      const accepted = await tx.staffInvite.updateMany({
        where: { id: invite.id, acceptedAt: null, revokedAt: null },
        data: { acceptedAt: now },
      });
      const membershipKey = {
        organisationId: invite.organisationId,
        userId: user.id,
        role: invite.role,
      };
      // Joining activates the invited membership; a reset needs the membership still active
      // (an admin may have removed the person since issuing the link).
      const membershipOk =
        invite.purpose === 'join'
          ? (
              await tx.membership.updateMany({
                where: { ...membershipKey, status: 'invited' },
                data: { status: 'active' },
              })
            ).count === 1
          : (await tx.membership.count({ where: { ...membershipKey, status: 'active' } })) === 1;
      if (accepted.count !== 1 || !membershipOk) return { error: INVALID_INVITE() };

      await tx.user.update({
        where: { id: user.id },
        data: {
          mfaLastUsedStep: step,
          failedLoginCount: 0,
          lastLoginAt: now,
          ...(enrolling ? { mfaSecret: encrypted, mfaPendingSecret: null } : {}),
        },
      });
      const base = { organisationId: invite.organisationId, actorUserId: user.id };
      await writeAudit(tx, request, {
        ...base,
        action: invite.purpose === 'reset' ? 'staff.reset.completed' : 'staff.invite.accepted',
        entityType: 'staff_invite',
        entityId: invite.id,
      });
      if (enrolling) await writeAudit(tx, request, { ...base, action: 'auth.mfa.enrolled' });
      const tokens = await this.auth.startSession(
        tx,
        request,
        user.id,
        invite.organisationId,
        invite.role as StaffRole,
        STAFF_SESSION_MS,
      );
      await writeAudit(tx, request, { ...base, action: 'auth.login.succeeded' });
      return { tokens };
    });
    if ('error' in outcome) throw outcome.error;
    return outcome.tokens;
  }

  /** An invite that can still be used: open, unexpired, for an active organisation and user. */
  private async openInvite(tx: Tx, token: string) {
    const invite = await tx.staffInvite.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!invite || invite.acceptedAt || invite.revokedAt || invite.expiresAt <= this.s.now()) {
      return null;
    }
    // One after another: a transaction is one connection, which runs one query at a time.
    const organisation = await tx.organisation.findUnique({ where: { id: invite.organisationId } });
    const user = await tx.user.findUnique({ where: { id: invite.userId } });
    if (organisation?.status !== 'active' || user?.status !== 'active') return null;
    return { invite, organisation, user };
  }
}

/**
 * The person an invite is for, found by email or mobile or given a new account with no
 * password yet. Runs as the sign-in role. A disabled account cannot be invited.
 */
export async function findOrCreateInvitee(
  tx: Tx,
  identity: { email: string } | { phone: string },
  displayName: string | undefined,
) {
  const existing =
    'email' in identity
      ? await tx.user.findUnique({ where: { email: identity.email } })
      : await tx.user.findUnique({ where: { phone: identity.phone } });
  const user =
    existing ?? (await tx.user.create({ data: { ...identity, displayName: displayName ?? null } }));
  if (user.status !== 'active') {
    throw new AppError(409, 'CONFLICT', 'This person’s account is disabled.');
  }
  return user;
}

/**
 * `findOrCreateInvitee` in its own sign-in transaction. Two invites for a new person at
 * once can both try to create the account; the loser's insert fails on the unique email
 * or mobile and aborts its transaction, so it reads the winner's account in a new one.
 */
export async function inviteeAccount(
  db: Db,
  identity: { email: string } | { phone: string },
  displayName: string | undefined,
) {
  try {
    return await withAuth(db, (tx) => findOrCreateInvitee(tx, identity, displayName));
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) {
      throw error;
    }
    return withAuth(db, (tx) => findOrCreateInvitee(tx, identity, displayName));
  }
}

export interface JoinInviteParams {
  organisationId: string;
  user: { id: string };
  role: StaffRole;
  now: Date;
  /** The clinic admin issuing it; for a platform-issued invite, the invitee (as for support resets). */
  createdByUserId: string;
  /** Null when the platform team issued it; `metadata` then names the operator. */
  actorUserId: string | null;
  metadata?: Record<string, string>;
}

/**
 * Inside the organisation (tenant role): marks the membership invited and issues a new
 * single-use join link, replacing any open one for the same person and role. Shared by
 * clinic admins' invites and platform onboarding. The URL is returned once.
 */
export async function issueJoinInvite(
  tx: Tx,
  request: AuditSource,
  s: Pick<Services, 'webBaseUrl'>,
  params: JoinInviteParams,
) {
  const { organisationId, user, role, now } = params;
  const token = randomBytes(32).toString('base64url');
  const key = { organisationId, userId: user.id, role };
  const membership = await tx.membership.findUnique({
    where: { organisationId_userId_role: key },
  });
  if (membership?.status === 'active') {
    throw new AppError(409, 'CONFLICT', 'This person already has that role.', {
      identifier: 'exists',
    });
  }
  if (membership) {
    // Waits for an overlapping invite's transaction, then replaces its link below. Only a
    // membership that is still not active: an earlier invite accepted meanwhile is kept.
    const reopened = await tx.membership.updateMany({
      where: { id: membership.id, status: { not: 'active' } },
      data: { status: 'invited' },
    });
    if (reopened.count !== 1) {
      throw new AppError(409, 'CONFLICT', 'This person already has that role.', {
        identifier: 'exists',
      });
    }
  } else {
    try {
      await tx.membership.create({ data: { ...key, status: 'invited' } });
    } catch (error) {
      // Another invite for the same person and role created the membership at the same
      // moment. This transaction is aborted, so answer as for an existing invite.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new AppError(
          409,
          'CONFLICT',
          'This person was invited to that role a moment ago. Check the invite list.',
          { identifier: 'invited' },
        );
      }
      throw error;
    }
  }
  // A new invite replaces any earlier open one for the same person and role.
  await tx.staffInvite.updateMany({
    where: { ...key, acceptedAt: null, revokedAt: null },
    data: { revokedAt: now },
  });
  const invite = await tx.staffInvite.create({
    data: {
      ...key,
      tokenHash: hashToken(token),
      createdByUserId: params.createdByUserId,
      expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
      createdAt: now,
    },
  });
  await writeAudit(tx, request, {
    action: 'staff.invite.created',
    organisationId,
    actorUserId: params.actorUserId,
    entityType: 'staff_invite',
    entityId: invite.id,
    metadata: { role, invitedUserId: user.id, ...params.metadata },
  });
  // The token rides in the URL fragment, which browsers never send to servers or logs.
  return { invite, inviteUrl: `${s.webBaseUrl}/invite#${token}` };
}

export function toStaffInvite(
  invite: InviteRow,
  user: InviteeIdentity | undefined,
  now: Date,
): StaffInvite {
  const status = invite.revokedAt
    ? 'revoked'
    : invite.acceptedAt
      ? 'accepted'
      : invite.expiresAt <= now
        ? 'expired'
        : 'pending';
  return {
    id: invite.id,
    role: invite.role as StaffRole,
    identifier: user?.email ?? user?.phone ?? '',
    displayName: user?.displayName ?? null,
    status,
    expiresAt: invite.expiresAt.toISOString(),
    createdAt: invite.createdAt.toISOString(),
  };
}

export function parseIdentifier(raw: string): { email: string } | { phone: string } {
  const value = raw.trim();
  if (value.includes('@')) {
    const email = value.toLowerCase();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { email };
  } else {
    const phone = normaliseIndianMobile(value);
    if (phone) return { phone };
  }
  throw new AppError(400, 'VALIDATION_FAILED', 'Enter an email address or Indian mobile number.', {
    identifier: 'invalid',
  });
}

/** `doctor@clinic.test` → `do****@clinic.test`; `+919876543210` → `+91******3210`. */
export function maskIdentifier(identifier: string): string {
  const at = identifier.indexOf('@');
  if (at > 0) return `${identifier.slice(0, Math.min(2, at))}****${identifier.slice(at)}`;
  if (identifier.length > 7) return `${identifier.slice(0, 3)}******${identifier.slice(-4)}`;
  return '****';
}
