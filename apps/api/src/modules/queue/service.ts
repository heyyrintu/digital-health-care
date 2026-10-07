import type {
  Appointment,
  CreateDisplayScreenBody,
  CreatedDisplayScreen,
  DisplayBoard,
  DisplayScreen,
  QueueQuery,
  QueueResponse,
  Role,
} from '@dhc/contracts';
import { withAuth, withTenant } from '@dhc/db';
import { istDate } from '@dhc/domain';
import type { FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { hashToken } from '../../auth/tokens';
import { AppError } from '../../errors';
import type { Services } from '../../services';
import { AppointmentService } from '../appointments/service';
import { writeAudit } from '../audit/write';

interface Actor {
  userId: string;
  organisationId: string;
  role: Role;
}

const time = (iso: string | null) => (iso ? Date.parse(iso) : Number.POSITIVE_INFINITY);
const isPriority = (a: Appointment) => a.patient.tags.some((t) => t.sortToTop);

/**
 * Who is seen next among checked-in patients: tags marked "show first" (Emergency,
 * Priority) come before everyone else, then arrival order (PRD §5.1, §5.4).
 */
export function waitingOrder(a: Appointment, b: Appointment): number {
  const priority = Number(isPriority(b)) - Number(isPriority(a));
  return priority || time(a.checkedInAt) - time(b.checkedInAt) || a.tokenNumber - b.tokenNumber;
}

/** Groups a day's appointments into the queue tabs, each in its working order. */
export function toQueue(date: string, all: Appointment[]): QueueResponse {
  const by = (statuses: Appointment['status'][]) => all.filter((a) => statuses.includes(a.status));
  const inConsultation = by(['in_consultation']).sort(
    (a, b) => time(a.consultationStartedAt) - time(b.consultationStartedAt),
  );
  const durations = by(['completed'])
    .filter((a) => a.consultationStartedAt && a.completedAt)
    .map((a) => (time(a.completedAt) - time(a.consultationStartedAt)) / 60_000);
  return {
    date,
    myOpd: [...inConsultation, ...by(['checked_in']).sort(waitingOrder)],
    booked: by(['pending', 'confirmed']).sort((a, b) => time(a.startAt) - time(b.startAt)),
    completed: by(['completed']).sort((a, b) => time(b.completedAt) - time(a.completedAt)),
    closed: by(['cancelled', 'no_show', 'rescheduled']).sort(
      (a, b) => time(a.startAt) - time(b.startAt),
    ),
    averageConsultationMinutes:
      durations.length > 0
        ? Math.round((durations.reduce((s, d) => s + d, 0) / durations.length) * 10) / 10
        : null,
  };
}

const NOT_FOUND = () => new AppError(404, 'NOT_FOUND', 'Not found.');
const BAD_SCREEN = () =>
  new AppError(
    404,
    'NOT_FOUND',
    'This screen link is not valid. Ask your clinic admin for a new one.',
  );

/** How many waiting tokens a screen shows per doctor after the one being seen. */
const NEXT_ON_SCREEN = 5;

/**
 * The live queue (PRD §5.1) and waiting-room screens (PRD §5.3). Screens are kiosk
 * links: a random token whose SHA-256 hash is stored; they show tokens, never names.
 */
export class QueueService {
  private readonly appointments: AppointmentService;

  constructor(private readonly s: Services) {
    this.appointments = new AppointmentService(s);
  }

  async queue(actor: Actor, query: QueueQuery): Promise<QueueResponse> {
    const date = query.date ?? istDate(this.s.now());
    const all = await this.appointments.list(actor, {
      date,
      doctorId: query.doctorId,
      clinicId: query.clinicId,
    });
    return toQueue(date, all);
  }

  async listScreens(actor: Actor): Promise<DisplayScreen[]> {
    const rows = await withTenant(this.s.db, actor.organisationId, (tx) =>
      tx.displayScreen.findMany({
        where: { revokedAt: null },
        include: { clinic: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
      }),
    );
    return rows.map((r) => ({
      id: r.id,
      clinicId: r.clinicId,
      clinicName: r.clinic.name,
      label: r.label,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async createScreen(
    request: FastifyRequest,
    actor: Actor,
    body: CreateDisplayScreenBody,
  ): Promise<CreatedDisplayScreen> {
    const token = randomBytes(32).toString('base64url');
    return withTenant(this.s.db, actor.organisationId, async (tx) => {
      const clinic = await tx.clinic.findUnique({ where: { id: body.clinicId } });
      if (!clinic?.active) {
        throw new AppError(400, 'VALIDATION_FAILED', 'Choose an active clinic.', {
          clinicId: 'invalid',
        });
      }
      const screen = await tx.displayScreen.create({
        data: {
          organisationId: actor.organisationId,
          clinicId: clinic.id,
          label: body.label,
          tokenHash: hashToken(token),
          createdByUserId: actor.userId,
        },
      });
      await writeAudit(tx, request, {
        action: 'display_screen.created',
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        entityType: 'display_screen',
        entityId: screen.id,
        metadata: { clinicId: clinic.id },
      });
      return {
        id: screen.id,
        clinicId: clinic.id,
        clinicName: clinic.name,
        label: screen.label,
        createdAt: screen.createdAt.toISOString(),
        link: `${this.s.webBaseUrl}/display#${token}`,
      };
    });
  }

  async revokeScreen(request: FastifyRequest, actor: Actor, id: string): Promise<void> {
    await withTenant(this.s.db, actor.organisationId, async (tx) => {
      const screen = await tx.displayScreen.findUnique({ where: { id } });
      if (!screen || screen.revokedAt) throw NOT_FOUND();
      await tx.displayScreen.update({ where: { id }, data: { revokedAt: this.s.now() } });
      await writeAudit(tx, request, {
        action: 'display_screen.revoked',
        organisationId: actor.organisationId,
        actorUserId: actor.userId,
        entityType: 'display_screen',
        entityId: id,
      });
    });
  }

  /** Today's board for a screen: per doctor, the token being seen and the next few. */
  async board(token: string): Promise<DisplayBoard> {
    const screen = await withAuth(this.s.db, (tx) =>
      tx.displayScreen.findUnique({ where: { tokenHash: hashToken(token) } }),
    );
    if (!screen || screen.revokedAt) throw BAD_SCREEN();

    const date = istDate(this.s.now());
    const actor: Actor = {
      userId: screen.createdByUserId,
      organisationId: screen.organisationId,
      role: 'clinic_admin',
    };
    const [clinic, queue] = await Promise.all([
      withTenant(this.s.db, screen.organisationId, (tx) =>
        tx.clinic.findUnique({ where: { id: screen.clinicId }, select: { name: true } }),
      ),
      this.queue(actor, { date, clinicId: screen.clinicId }),
    ]);
    if (!clinic) throw BAD_SCREEN();

    const doctors = new Map<string, DisplayBoard['doctors'][number]>();
    for (const a of queue.myOpd) {
      const entry = doctors.get(a.doctorUserId) ?? {
        doctorName: a.doctorName,
        nowServing: null,
        next: [],
      };
      if (a.status === 'in_consultation') {
        entry.nowServing ??= a.tokenNumber;
      } else if (entry.next.length < NEXT_ON_SCREEN) {
        entry.next.push(a.tokenNumber);
      }
      doctors.set(a.doctorUserId, entry);
    }
    return {
      clinicName: clinic.name,
      date,
      doctors: [...doctors.values()].sort((a, b) =>
        (a.doctorName ?? '').localeCompare(b.doctorName ?? ''),
      ),
    };
  }
}
