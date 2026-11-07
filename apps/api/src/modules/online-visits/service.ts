import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  ONLINE_CONSENT_VERSION,
  onlineAgeAt,
  OnlineIdentity,
  OnlineVisit,
  isMeetingUrl,
  type OnlineIntake,
  type OnlineCall,
  type OnlineVerify,
} from '@dhc/contracts';
import { withAuth, withTenant, type Tx } from '@dhc/db';
import type { FastifyRequest } from 'fastify';
import type { Services } from '../../services';
import { AppError } from '../../errors';
import { accountPhone, ownPatient } from '../portal/account';
import { PortalService } from '../portal/service';
import { writeAudit } from '../audit/write';
const State = z.object({
  patientId: z.uuid(),
  doctorUserId: z.uuid(),
  snapshot: z.string(),
  settingsVersion: z.number(),
  identity: OnlineIdentity.nullable(),
  consentAt: z.string().nullable(),
  consentVersion: z.string().nullable().default(null),
  verificationMethod: z.enum(['audio', 'video']).nullable().default(null),
  consentBy: z.string().nullable(),
  consentPhone: z.string().nullable(),
  verifiedBy: z.string().nullable(),
  verifiedAt: z.string().nullable(),
  meetingUrl: z.string().nullable(),
  callPhone: z.string().nullable(),
});
type State = z.infer<typeof State>;
type Actor = { organisationId: string; userId: string; role?: string };
const conflict = (message: string) => new AppError(409, 'CONFLICT', message);
const missing = () => new AppError(404, 'NOT_FOUND', 'Online visit not found.');
const active = ['pending', 'confirmed', 'checked_in', 'in_consultation'];
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
// Decode only with the configured field cipher; exported readiness checks share the same context.
async function context(s: Services, tx: Tx, id: string) {
  const a = await tx.appointment.findUnique({
    where: { id },
    include: { consultationType: true, patient: true },
  });
  if (!a || a.consultationType.mode === 'in_person') throw missing();
  await tx.$queryRaw`SELECT organisation_id FROM online_visit_settings WHERE organisation_id=${a.organisationId}::uuid FOR SHARE`;
  const settings = await tx.onlineVisitSettings.findUnique({
      where: { organisationId: a.organisationId },
    }),
    row = await tx.onlineVisit.findUnique({ where: { appointmentId: id } }),
    guardian = a.patient.guardianPatientId
      ? await tx.patient.findUnique({ where: { id: a.patient.guardianPatientId } })
      : null;
  const snapshot = hash([
    a.id,
    a.patientId,
    a.doctorUserId,
    a.clinicId,
    a.consultationTypeId,
    a.startAt,
    a.endAt,
    a.consultationType.mode,
    a.patient.updatedAt,
    guardian?.updatedAt,
  ]);
  const saved = row ? State.parse(JSON.parse(s.cipher.decrypt(row.stateCipher))) : null,
    stale =
      !!saved &&
      (saved.snapshot !== snapshot || saved.settingsVersion !== (settings?.version ?? 0));
  const state: State =
    saved && !stale
      ? saved
      : {
          patientId: a.patientId,
          doctorUserId: a.doctorUserId,
          snapshot,
          settingsVersion: settings?.version ?? 0,
          identity: null,
          consentAt: null,
          consentVersion: null,
          verificationMethod: null,
          consentBy: null,
          consentPhone: null,
          verifiedAt: null,
          verifiedBy: null,
          meetingUrl: null,
          callPhone: null,
        };
  const profile = await tx.doctorProfile.findFirst({ where: { userId: a.doctorUserId } });
  const doctor = await withAuth(s.db, (t) =>
    t.user.findUnique({
      where: { id: a.doctorUserId },
      select: { displayName: true, status: true },
    }),
  );
  const holder = state.consentBy
    ? await withAuth(s.db, (t) =>
        t.user.findUnique({
          where: { id: state.consentBy! },
          select: { phone: true, status: true },
        }),
      )
    : null;
  const membership = state.consentBy
    ? await tx.membership.count({
        where: { userId: state.consentBy, role: 'patient', status: 'active' },
      })
    : 0;
  let consented = !!(
    state.identity &&
    state.consentAt &&
    state.consentVersion === ONLINE_CONSENT_VERSION &&
    holder?.status === 'active' &&
    holder.phone === state.consentPhone &&
    membership
  );
  if (consented) {
    try {
      await new PortalService(s).requireConsents(tx, {
        userId: state.consentBy!,
        organisationId: a.organisationId,
      });
      await ownPatient(tx, state.consentPhone!, a.patientId);
    } catch (e) {
      if (e instanceof AppError) consented = false;
      else throw e;
    }
  }
  const usable = !!(
    settings?.enabled &&
    doctor?.status === 'active' &&
    profile?.verification === 'verified' &&
    profile.registrationNumber &&
    profile.council &&
    profile.qualifications &&
    doctor.displayName &&
    [...active, 'completed'].includes(a.status) &&
    !a.patient.mergedIntoId &&
    !a.patient.portalClosedAt &&
    (!guardian || (!guardian.mergedIntoId && !guardian.portalClosedAt))
  );
  return { a, row, state, stale, profile, doctor, consented, usable, settings };
}
export async function assertOnlineReady(s: Services, tx: Tx, id: string) {
  const a = await tx.appointment.findUnique({ where: { id }, include: { consultationType: true } });
  if (!a || a.consultationType.mode === 'in_person') return;
  const c = await context(s, tx, id);
  if (!c.usable || !c.consented || c.state.verifiedBy !== a.doctorUserId || !c.state.verifiedAt)
    throw conflict(
      'Complete online identity verification and patient consent before starting or signing this visit.',
    );
}
/** Corrections use retained evidence from before the original signature, not new care consent. */
export async function assertOnlineAmendmentEvidence(
  s: Services,
  tx: Tx,
  id: string,
  parentId: string,
) {
  const appointment = await tx.appointment.findUnique({
    where: { id },
    include: { consultationType: true },
  });
  if (!appointment || appointment.consultationType.mode === 'in_person') return;
  const parent = await tx.prescription.findUnique({ where: { id: parentId } });
  if (
    !parent ||
    parent.appointmentId !== id ||
    parent.patientId !== appointment.patientId ||
    parent.doctorUserId !== appointment.doctorUserId ||
    !parent.signedAt ||
    !['signed', 'superseded'].includes(parent.status)
  )
    throw conflict(
      'The signed parent and its original online verification evidence are required for this correction.',
    );
  const event = await tx.onlineVisitEvent.findFirst({
    where: { appointmentId: id, action: 'verify', actorUserId: parent.doctorUserId },
    orderBy: { version: 'asc' },
  });
  const state = event ? State.parse(JSON.parse(s.cipher.decrypt(event.stateCipher))) : null;
  if (
    !state?.identity ||
    state.patientId !== parent.patientId ||
    state.doctorUserId !== parent.doctorUserId ||
    !state.consentAt ||
    !state.consentBy ||
    !state.consentVersion ||
    !state.verifiedAt ||
    state.verifiedBy !== parent.doctorUserId ||
    state.verificationMethod !== appointment.consultationType.mode ||
    new Date(state.consentAt) > new Date(state.verifiedAt) ||
    new Date(state.verifiedAt) > parent.signedAt
  )
    throw conflict('The original online identity and consent evidence is unavailable.');
}
export class OnlineVisitsService {
  constructor(private s: Services) {}
  async settings(a: Actor, body?: { version: number; enabled: boolean }, req?: FastifyRequest) {
    return withTenant(this.s.db, a.organisationId, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${a.organisationId},85))`;
      let r = await tx.onlineVisitSettings.findUnique({
        where: { organisationId: a.organisationId },
      });
      if (body) {
        if ((r?.version ?? 0) !== body.version) throw conflict('Reload online settings.');
        r = await tx.onlineVisitSettings.upsert({
          where: { organisationId: a.organisationId },
          create: { organisationId: a.organisationId, enabled: body.enabled },
          update: { enabled: body.enabled, version: { increment: 1 } },
        });
      }
      if (body && req)
        await writeAudit(tx, req, {
          organisationId: a.organisationId,
          actorUserId: a.userId,
          action: 'online.settings_updated',
          entityType: 'organisation',
          entityId: a.organisationId,
          metadata: { enabled: body.enabled },
        });
      return { version: r?.version ?? 0, enabled: r?.enabled ?? false };
    });
  }
  private async access(tx: Tx, a: Actor, id: string, patient: boolean) {
    const row = await tx.appointment.findUnique({ where: { id } });
    if (!row) throw missing();
    if (patient) await ownPatient(tx, await accountPhone(this.s, a.userId), row.patientId);
    if (a.role === 'doctor' && row.doctorUserId !== a.userId) throw missing();
  }
  private async output(tx: Tx, a: Actor, id: string, patient: boolean) {
    const c = await context(this.s, tx, id),
      { state, profile, doctor } = c,
      now = this.s.now().getTime();
    const joinAvailable =
      c.usable &&
      c.consented &&
      ['confirmed', 'checked_in', 'in_consultation'].includes(c.a.status) &&
      now >= c.a.startAt.getTime() - 15 * 60000 &&
      now <= c.a.endAt.getTime() + 60 * 60000 &&
      !!(c.a.consultationType.mode === 'video' ? state.meetingUrl : state.callPhone);
    return OnlineVisit.parse({
      appointmentId: id,
      version: c.row?.version ?? 0,
      mode: c.a.consultationType.mode,
      enabled: c.settings?.enabled ?? false,
      stale: c.stale,
      consentVersion: ONLINE_CONSENT_VERSION,
      consented: c.consented,
      verified: !!state.verifiedAt && c.consented && c.usable,
      identity: patient || a.role === 'doctor' ? state.identity : null,
      patient: {
        id: c.a.patientId,
        name: c.a.patient.name,
        uhid: c.a.patient.uhid,
        dob: c.a.patient.dob?.toISOString().slice(0, 10) ?? null,
      },
      meetingUrl: patient ? null : state.meetingUrl,
      callPhone: patient ? null : state.callPhone,
      provider: state.meetingUrl
        ? new URL(state.meetingUrl).hostname
        : state.callPhone
          ? 'phone'
          : null,
      joinAvailable,
      startsAt: c.a.startAt.toISOString(),
      endsAt: c.a.endAt.toISOString(),
      doctor: {
        name: doctor?.displayName ?? null,
        registrationNumber: profile?.registrationNumber ?? null,
        council: profile?.council ?? null,
        qualifications: profile?.qualifications ?? null,
        verified: profile?.verification === 'verified',
      },
    });
  }
  async read(req: FastifyRequest, a: Actor, id: string, patient: boolean) {
    return withTenant(this.s.db, a.organisationId, async (tx) => {
      await this.access(tx, a, id, patient);
      await this.audit(tx, req, a, id, 'online.viewed');
      return this.output(tx, a, id, patient);
    });
  }
  async mutate(
    req: FastifyRequest,
    a: Actor,
    id: string,
    kind: 'intake' | 'withdraw' | 'call' | 'verify',
    body: { version: number },
    patient: boolean,
  ) {
    return withTenant(this.s.db, a.organisationId, async (tx) => {
      await tx.$queryRaw`SELECT id FROM appointments WHERE id=${id}::uuid FOR UPDATE`;
      await this.access(tx, a, id, patient);
      const c = await context(this.s, tx, id);
      if ((c.row?.version ?? 0) !== body.version)
        throw conflict('Online details changed. Reload before continuing.');
      const state = c.state;
      if (kind !== 'withdraw' && (!c.usable || !active.includes(c.a.status)))
        throw conflict('This online visit is disabled, closed, or its doctor is not verified.');
      if (kind === 'intake') {
        await new PortalService(this.s).requireConsents(tx, a);
        const b = body as z.infer<typeof OnlineIntake>,
          now = this.s.now(),
          age = onlineAgeAt(b.identity.dob, now);
        if (c.a.patient.dob && c.a.patient.dob.toISOString().slice(0, 10) !== b.identity.dob)
          throw conflict(
            'Date of birth differs from the patient profile. Ask the clinic to review the profile first.',
          );
        if (
          b.identity.dob > new Date(now.getTime() + 330 * 60000).toISOString().slice(0, 10) ||
          age > 130
        )
          throw conflict('Enter a valid date of birth.');
        if (age < 18 && (!b.identity.guardianName || !b.identity.guardianRelationship))
          throw conflict('A minor needs an adult guardian name and relationship.');
        state.identity = b.identity;
        state.consentBy = a.userId;
        state.consentPhone = await accountPhone(this.s, a.userId);
        state.consentAt = now.toISOString();
        state.consentVersion = ONLINE_CONSENT_VERSION;
        state.verificationMethod = null;
        state.verifiedAt = null;
        state.verifiedBy = null;
      } else if (kind === 'withdraw') {
        state.consentAt = null;
        state.verificationMethod = null;
        state.verifiedAt = null;
        state.verifiedBy = null;
      } else if (kind === 'call') {
        const b = body as z.infer<typeof OnlineCall>;
        if (
          c.a.consultationType.mode === 'video'
            ? !b.meetingUrl || b.callPhone !== null
            : !b.callPhone || b.meetingUrl !== null
        )
          throw conflict('Provide only the contact matching the appointment mode.');
        state.meetingUrl = b.meetingUrl;
        state.callPhone = b.callPhone;
      } else {
        const b = body as z.infer<typeof OnlineVerify>;
        if (a.userId !== c.a.doctorUserId || a.role !== 'doctor')
          throw new AppError(403, 'FORBIDDEN', 'Only the assigned doctor can verify identity.');
        if (!c.consented || !state.identity)
          throw conflict('The patient must complete online consent first.');
        if (!c.a.patient.dob || c.a.patient.dob.toISOString().slice(0, 10) !== state.identity.dob)
          throw conflict(
            'Confirm the date of birth in the patient profile, then ask the patient to complete online consent again.',
          );
        if (b.method !== c.a.consultationType.mode)
          throw conflict('Verification method must match the booked mode.');
        if (state.identity.guardianName && !b.guardianConfirmed)
          throw conflict('Confirm the guardian identity and authority.');
        state.verifiedAt = this.s.now().toISOString();
        state.verificationMethod = b.method;
        state.verifiedBy = a.userId;
      }
      const version = (c.row?.version ?? 0) + 1,
        cipher = this.s.cipher.encrypt(JSON.stringify(state));
      await tx.onlineVisit.upsert({
        where: { appointmentId: id },
        create: {
          appointmentId: id,
          organisationId: a.organisationId,
          version,
          stateCipher: cipher,
        },
        update: { version, stateCipher: cipher },
      });
      await tx.onlineVisitEvent.create({
        data: {
          id: randomUUID(),
          organisationId: a.organisationId,
          appointmentId: id,
          version,
          actorUserId: a.userId,
          action: kind,
          stateCipher: cipher,
        },
      });
      await this.audit(tx, req, a, id, 'online.' + kind);
      return this.output(tx, a, id, patient);
    });
  }
  async join(req: FastifyRequest, a: Actor, id: string) {
    return withTenant(this.s.db, a.organisationId, async (tx) => {
      await tx.$queryRaw`SELECT id FROM appointments WHERE id=${id}::uuid FOR UPDATE`;
      await this.access(tx, a, id, true);
      await new PortalService(this.s).requireConsents(tx, a);
      const view = await this.output(tx, a, id, true);
      if (!view.joinAvailable)
        throw conflict('Joining is unavailable. Confirm consent or contact the clinic.');
      const c = await context(this.s, tx, id),
        url =
          c.a.consultationType.mode === 'video' ? c.state.meetingUrl! : 'tel:' + c.state.callPhone!;
      if (c.a.consultationType.mode === 'video' && !isMeetingUrl(url))
        throw conflict('Invalid meeting link.');
      await this.audit(tx, req, a, id, 'online.join_authorized');
      return { url };
    });
  }
  private audit(tx: Tx, req: FastifyRequest, a: Actor, id: string, action: string) {
    return writeAudit(tx, req, {
      organisationId: a.organisationId,
      actorUserId: a.userId,
      action,
      entityType: 'appointment',
      entityId: id,
    });
  }
}
