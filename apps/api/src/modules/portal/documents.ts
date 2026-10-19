import type { PortalDocument, PortalDocumentListQuery } from '@dhc/contracts';
import { withTenant } from '@dhc/db';
import type { FastifyRequest } from 'fastify';
import type { Services } from '../../services';
import { DocumentsService } from '../documents/service';
import { accountHistoryWhere, accountPhone, ownHistory } from './account';
import { PortalService } from './service';

interface Actor {
  userId: string;
  organisationId: string;
}

/**
 * The family's shared documents in the Patient app and web portal (PRD §7.3, §4.4): what
 * doctors shared with the account's patients (and records merged into them), not
 * withdrawn, and opening them. Health data needs the onboarding consents, as for
 * prescriptions and tests.
 */
export class PortalDocumentsService {
  private readonly documents: DocumentsService;
  private readonly portal: PortalService;

  constructor(private readonly s: Services) {
    this.documents = new DocumentsService(s);
    this.portal = new PortalService(s);
  }

  async list(
    request: FastifyRequest,
    actor: Actor,
    query: PortalDocumentListQuery,
  ): Promise<{ data: PortalDocument[]; nextCursor: string | null }> {
    const phone = await accountPhone(this.s, actor.userId);
    const patients = await withTenant(this.s.db, actor.organisationId, async (tx) => {
      await this.portal.requireConsents(tx, actor);
      return tx.patient.findMany({
        where: accountHistoryWhere(phone),
        select: { id: true, name: true, mergedInto: { select: { id: true, name: true } } },
      });
    });
    return this.documents.forAccount(request, { ...actor, role: 'patient' }, patients, query);
  }

  async file(request: FastifyRequest, actor: Actor, id: string) {
    const phone = await accountPhone(this.s, actor.userId);
    return this.documents.file(
      request,
      { ...actor, role: 'patient' },
      id,
      async (tx, patientId) => {
        await this.portal.requireConsents(tx, actor);
        await ownHistory(tx, phone, patientId);
      },
    );
  }
}
