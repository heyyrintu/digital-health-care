import type { PortalTestOrder, TestOrder } from '@dhc/contracts';
import { withTenant } from '@dhc/db';
import type { FastifyRequest } from 'fastify';
import type { Services } from '../../services';
import { OrdersService } from '../orders/service';
import type { UploadedFile } from '../orders/upload';
import { accountHistoryWhere, accountPhone, ownHistory } from './account';
import { PortalService } from './service';

interface Actor {
  userId: string;
  organisationId: string;
}

/**
 * The family's test orders in the Patient app (PRD §4.4, §7.1): what was ordered, upload a
 * result against it, and open the results. Only the account's patients (and records merged
 * into them); health data needs the onboarding consents.
 */
export class PortalOrdersService {
  private readonly orders: OrdersService;
  private readonly portal: PortalService;

  constructor(private readonly s: Services) {
    this.orders = new OrdersService(s);
    this.portal = new PortalService(s);
  }

  async list(request: FastifyRequest, actor: Actor): Promise<PortalTestOrder[]> {
    const phone = await accountPhone(this.s, actor.userId);
    const patients = await withTenant(this.s.db, actor.organisationId, async (tx) => {
      await this.portal.requireConsents(tx, actor);
      return tx.patient.findMany({
        where: accountHistoryWhere(phone),
        select: { id: true, name: true, mergedInto: { select: { id: true, name: true } } },
      });
    });
    return this.orders.forAccount(request, { ...actor, role: 'patient' }, patients);
  }

  async upload(
    request: FastifyRequest,
    actor: Actor,
    orderId: string,
    file: UploadedFile,
  ): Promise<TestOrder> {
    const phone = await accountPhone(this.s, actor.userId);
    return this.orders.upload(
      request,
      { ...actor, role: 'patient' },
      orderId,
      file,
      async (tx, patientId) => {
        await this.portal.requireConsents(tx, actor);
        await ownHistory(tx, phone, patientId);
      },
    );
  }

  async resultFile(request: FastifyRequest, actor: Actor, resultId: string) {
    const phone = await accountPhone(this.s, actor.userId);
    return this.orders.resultFile(
      request,
      { ...actor, role: 'patient' },
      resultId,
      async (tx, patientId) => {
        await this.portal.requireConsents(tx, actor);
        await ownHistory(tx, phone, patientId);
      },
    );
  }
}
