import {
  AmendPrescriptionBody,
  LastPrescription,
  LastPrescriptionQuery,
  MedicineList,
  MedicineQuery,
  Prescription,
  PrescriptionCheck,
  PrescriptionTemplate,
  PrescriptionTemplateList,
  PrescriptionView,
  SafetyActionBody,
  SafetySummary,
  SavePrescriptionBody,
  SaveTemplateBody,
  SignPrescriptionBody,
  VerifyPrescriptionBody,
  VoidPrescriptionBody,
} from '@dhc/contracts';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { authOf, authenticate, requireRole } from '../../plugins/authenticate';
import type { Services } from '../../services';
import { PrescribingService } from './service';
import { SigningService } from './signing';

const IdParams = z.object({ id: z.uuid() });

/** Public QR checks: enough for a busy pharmacy counter, too few to walk through codes. */
const VERIFY_RATE_LIMIT = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };

const sendPdf = (reply: FastifyReply, file: Buffer, filename: string) =>
  reply
    .type('application/pdf')
    .header('Content-Disposition', `inline; filename="${filename}"`)
    .header('Cache-Control', 'no-store')
    .send(file);

/** The prescription builder and its safety checks (PRD §6.4, §6.5, §3.2): doctors only. */
export const prescribingRoutes: FastifyPluginAsync<{
  services: Services;
  /** Requests checking a password or PIN, per client address per minute. */
  signInRateLimit: number;
}> = async (app, { services, signInRateLimit }) => {
  const PIN_RATE_LIMIT = { rateLimit: { max: signInRateLimit, timeWindow: '1 minute' } };
  const prescribing = new PrescribingService(services);
  const signing = new SigningService(services);
  const doctor = { preHandler: [authenticate(services), requireRole('doctor')] };
  // The front desk prints signed prescriptions at the counter (PRD §3.2).
  const printing = {
    preHandler: [authenticate(services), requireRole('doctor', 'front_desk')],
  };

  app.get('/medicines', doctor, async (request) => {
    const { q } = MedicineQuery.parse(request.query);
    return MedicineList.parse({ data: await prescribing.searchMedicines(authOf(request), q) });
  });

  app.get('/appointments/:id/prescription', doctor, async (request) => {
    const { id } = IdParams.parse(request.params);
    return PrescriptionView.parse(await prescribing.view(request, authOf(request), id));
  });

  app.put('/appointments/:id/prescription', doctor, async (request) => {
    const { id } = IdParams.parse(request.params);
    const body = SavePrescriptionBody.parse(request.body);
    return Prescription.parse(await prescribing.save(request, authOf(request), id, body));
  });

  app.post('/appointments/:id/prescription/safety-actions', doctor, async (request) => {
    const { id } = IdParams.parse(request.params);
    const body = SafetyActionBody.parse(request.body);
    return SafetySummary.parse(await prescribing.act(request, authOf(request), id, body));
  });

  app.get('/appointments/:id/prescription/preview', doctor, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const file = await signing.preview(request, authOf(request), id);
    return sendPdf(reply, file, 'preview.pdf');
  });

  app.post(
    '/appointments/:id/prescription/sign',
    { ...doctor, config: PIN_RATE_LIMIT },
    async (request) => {
      const { id } = IdParams.parse(request.params);
      const body = SignPrescriptionBody.parse(request.body);
      return Prescription.parse(await signing.sign(request, authOf(request), id, body));
    },
  );

  app.post('/appointments/:id/prescription/amend', doctor, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const body = AmendPrescriptionBody.parse(request.body);
    const draft = await signing.amend(request, authOf(request), id, body);
    return reply.status(201).send(Prescription.parse(draft));
  });

  app.post(
    '/appointments/:id/prescription/void',
    { ...doctor, config: PIN_RATE_LIMIT },
    async (request) => {
      const { id } = IdParams.parse(request.params);
      const body = VoidPrescriptionBody.parse(request.body);
      return Prescription.parse(await signing.void(request, authOf(request), id, body));
    },
  );

  app.get('/prescriptions/:id/pdf', printing, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const { file, filename } = await signing.pdf(request, authOf(request), id);
    return sendPdf(reply, file, filename);
  });

  // Public: the code from the QR is the only key. In the body, not the URL, so it stays
  // out of access logs.
  app.post('/verify', VERIFY_RATE_LIMIT, async (request) => {
    const { code } = VerifyPrescriptionBody.parse(request.body);
    return PrescriptionCheck.parse(await signing.verify(code));
  });

  app.get('/patients/:id/last-prescription', doctor, async (request) => {
    const { id } = IdParams.parse(request.params);
    const { before } = LastPrescriptionQuery.parse(request.query);
    return LastPrescription.parse({
      last: await prescribing.last(request, authOf(request), id, before),
    });
  });

  app.get('/prescription-templates', doctor, async (request) =>
    PrescriptionTemplateList.parse({ data: await prescribing.templates(authOf(request)) }),
  );

  app.post('/prescription-templates', doctor, async (request, reply) => {
    const body = SaveTemplateBody.parse(request.body);
    const saved = await prescribing.saveTemplate(request, authOf(request), body);
    return reply.status(201).send(PrescriptionTemplate.parse(saved));
  });

  app.delete('/prescription-templates/:id', doctor, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    await prescribing.deleteTemplate(request, authOf(request), id);
    return reply.status(204).send();
  });
};
