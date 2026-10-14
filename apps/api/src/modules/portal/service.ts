import {
  ACCOUNT_CONSENT_KINDS,
  CURRENT_CONSENT_VERSIONS,
  type AcceptConsentsBody,
  type AccountConsentKind,
  type ConsentStatus,
  type CreatePortalPatientBody,
  type PortalPatient,
} from '@dhc/contracts';
import { withTenant, type Tx } from '@dhc/db';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../../errors';
import type { Services } from '../../services';
import { writeAudit } from '../audit/write';
import { allocateUhid } from '../patients/service';
import { accountPatientsWhere, accountPhone, ownPatient } from './account';

interface Actor {
  userId: string;
  organisationId: string;
}

const invalid = (field: string, message: string) =>
  new AppError(400, 'VALIDATION_FAILED', message, { [field]: 'invalid' });

const cleanName = (name: string) => name.trim().replace(/\s+/g, ' ');

type PatientRow = Awaited<ReturnType<Tx['patient']['findFirst']>> & {};

function toPortalPatient(p: PatientRow, phone: string): PortalPatient {
  return {
    id: p.id,
    uhid: p.uhid,
    name: p.name,
    dob: p.dob ? p.dob.toISOString().slice(0, 10) : null,
    gender: p.gender,
    language: p.language,
    relation: p.phone === phone ? 'account' : 'dependant',
    guardianPatientId: p.phone === phone ? null : p.guardianPatientId,
  };
}

type ConsentRow = Awaited<ReturnType<Tx['accountConsent']['findMany']>>[number];

/** The acceptance in force for a kind (current version, not withdrawn), if any. */
const inForce = (rows: ConsentRow[], kind: AccountConsentKind) =>
  rows.find(
    (r) => r.kind === kind && !r.withdrawnAt && r.version === CURRENT_CONSENT_VERSIONS[kind],
  );

/** Kinds with no acceptance in force: never accepted, withdrawn, or an older version. */
async function pendingConsents(tx: Tx, actor: Actor): Promise<AccountConsentKind[]> {
  const rows = await tx.accountConsent.findMany({ where: { userId: actor.userId } });
  return ACCOUNT_CONSENT_KINDS.filter((kind) => !inForce(rows, kind));
}

/**
 * The signed-in patient's account (PRD §4.1): consents, the family's records, and adding a
 * record. Health data is only shown or created once every consent in force is accepted.
 */
export class PortalService {
  constructor(private readonly s: Services) {}

  consents(actor: Actor): Promise<ConsentStatus> {
    return withTenant(this.s.db, actor.organisationId, (tx) => this.consentStatus(tx, actor));
  }

  async acceptConsents(
    request: FastifyRequest,
    actor: Actor,
    body: AcceptConsentsBody,
  ): Promise<ConsentStatus> {
    const kinds = body.accept.map((a) => a.kind);
    if (new Set(kinds).size !== kinds.length) {
      throw invalid('accept', 'List each consent once.');
    }
    for (const { kind, version } of body.accept) {
      if (version !== CURRENT_CONSENT_VERSIONS[kind]) {
        throw new AppError(
          409,
          'CONFLICT',
          'This document has been updated. Read the new version and accept it again.',
          { [kind]: 'outdated' },
        );
      }
    }
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      const pending = await pendingConsents(tx, actor);
      const fresh = body.accept.filter((a) => pending.includes(a.kind));
      const acceptedAt = this.s.now();
      const recorded: typeof fresh = [];
      for (const { kind, version } of fresh) {
        // Two taps at once: the in-force index keeps one row, and the other records nothing.
        const { count } = await tx.accountConsent.createMany({
          data: {
            organisationId: actor.organisationId,
            userId: actor.userId,
            kind,
            version,
            acceptedAt,
          },
          skipDuplicates: true,
        });
        if (count) recorded.push({ kind, version });
      }
      if (recorded.length) {
        await writeAudit(tx, request, {
          action: 'consent.accepted',
          organisationId: actor.organisationId,
          actorUserId: actor.userId,
          entityType: 'account',
          entityId: actor.userId,
          metadata: { consents: recorded.map((a) => `${a.kind}@${a.version}`) },
        });
      }
      return this.consentStatus(tx, actor);
    });
  }

  /**
   * Withdraws the health-data consent. The privacy notice and terms are not withdrawn on
   * their own: that is closing the account, which is a data-rights request.
   */
  async withdrawHealthData(request: FastifyRequest, actor: Actor): Promise<ConsentStatus> {
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      const now = this.s.now();
      const { count } = await tx.accountConsent.updateMany({
        where: { userId: actor.userId, kind: 'health_data', withdrawnAt: null },
        data: { withdrawnAt: now },
      });
      if (count > 0) {
        await writeAudit(tx, request, {
          action: 'consent.withdrawn',
          organisationId: actor.organisationId,
          actorUserId: actor.userId,
          entityType: 'account',
          entityId: actor.userId,
          metadata: { kind: 'health_data' },
        });
      }
      return this.consentStatus(tx, actor);
    });
  }

  async patients(actor: Actor): Promise<PortalPatient[]> {
    const phone = await accountPhone(this.s, actor.userId);
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      await this.requireConsents(tx, actor);
      const rows = await tx.patient.findMany({
        where: accountPatientsWhere(phone),
        orderBy: [{ createdAt: 'asc' }],
      });
      // Account records first, each followed by the dependants they look after.
      const accounts = rows.filter((p) => p.phone === phone);
      const ordered = accounts.flatMap((a) => [
        a,
        ...rows.filter((d) => d.phone !== phone && d.guardianPatientId === a.id),
      ]);
      return ordered.map((p) => toPortalPatient(p, phone));
    });
  }

  async addPatient(
    request: FastifyRequest,
    actor: Actor,
    body: CreatePortalPatientBody,
  ): Promise<PortalPatient> {
    const phone = await accountPhone(this.s, actor.userId);
    const name = cleanName(body.name);
    const dob = this.dob(body.dob);
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      await this.requireConsents(tx, actor);
      if (body.guardianPatientId) {
        const guardian = await ownPatient(tx, phone, body.guardianPatientId);
        if (guardian.phone !== phone) {
          throw invalid('guardianPatientId', 'Choose an adult on this account as the guardian.');
        }
      }
      // The clinic may have registered this person already; signing in claimed that record.
      const existing = await tx.patient.findFirst({
        where: {
          AND: [accountPatientsWhere(phone), { name: { equals: name, mode: 'insensitive' } }],
          dob,
        },
        select: { id: true },
      });
      if (existing) {
        throw new AppError(409, 'CONFLICT', `${name} is already on this account.`, {
          patientId: existing.id,
        });
      }
      const uhid = await allocateUhid(tx, actor.organisationId);
      const created = await tx.patient.create({
        data: {
          organisationId: actor.organisationId,
          uhid,
          name,
          dob,
          gender: body.gender,
          ...(body.language ? { language: body.language } : {}),
          ...(body.guardianPatientId
            ? { guardianPatientId: body.guardianPatientId, phone: null }
            : { phone }),
          accountUserId: actor.userId,
          createdByUserId: actor.userId,
        },
      });
      await writeAudit(tx, request, {
        action: 'patient.created',
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        entityType: 'patient',
        entityId: created.id,
        metadata: { source: 'patient_app', dependant: Boolean(body.guardianPatientId) },
      });
      return toPortalPatient(created, phone);
    });
  }

  private async consentStatus(tx: Tx, actor: Actor): Promise<ConsentStatus> {
    const rows = await tx.accountConsent.findMany({
      where: { userId: actor.userId },
      orderBy: { acceptedAt: 'desc' },
    });
    // The acceptance in force, else the most recent one (withdrawn or outdated).
    const latest = ACCOUNT_CONSENT_KINDS.flatMap((kind) => {
      const row = inForce(rows, kind) ?? rows.find((r) => r.kind === kind);
      return row ? [row] : [];
    }).sort((a, b) => b.acceptedAt.getTime() - a.acceptedAt.getTime());
    return {
      consents: latest.map((r) => ({
        kind: r.kind as AccountConsentKind,
        version: r.version,
        acceptedAt: r.acceptedAt.toISOString(),
        withdrawnAt: r.withdrawnAt?.toISOString() ?? null,
      })),
      pending: await pendingConsents(tx, actor),
    };
  }

  /** Health data needs every consent in force (PRD §4.1); the app sends people back to accept. */
  private async requireConsents(tx: Tx, actor: Actor) {
    const pending = await pendingConsents(tx, actor);
    if (pending.length > 0) {
      throw new AppError(
        403,
        'CONSENT_REQUIRED',
        'Please read and accept the privacy notice, terms and health-data consent first.',
        { consents: pending.join(',') },
      );
    }
  }

  private dob(raw: string): Date {
    const dob = new Date(`${raw}T00:00:00Z`);
    const now = this.s.now();
    const oldest = new Date(Date.UTC(now.getUTCFullYear() - 130, 0, 1));
    if (dob > now || dob < oldest) throw invalid('dob', 'Enter a real date of birth.');
    return dob;
  }
}
