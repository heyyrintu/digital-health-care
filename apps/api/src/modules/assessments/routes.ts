import {
  AssessmentForms,
  AssessmentForm,
  AssessmentPageQuery,
  CreateAssessmentForm,
  AssignAssessment,
  PatientAssessments,
  PatientAssessment,
  SubmitAssessment,
} from '@dhc/contracts';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Services } from '../../services';
import { authenticate, authOf, requireRole } from '../../plugins/authenticate';
import { AssessmentsService } from './service';
const Id = z.object({ id: z.uuid() });
export const assessmentRoutes: FastifyPluginAsync<{ services: Services }> = async (
  app,
  { services },
) => {
  const service = new AssessmentsService(services),
    auth = authenticate(services);
  const doctor = { preHandler: [auth, requireRole('doctor')] },
    patient = { preHandler: [auth, requireRole('patient')] },
    manage = { preHandler: [auth, requireRole('doctor', 'clinic_admin')] };
  const limited = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };
  app.get('/assessment-forms', manage, async (r) =>
    AssessmentForms.parse(
      await service.forms(authOf(r), AssessmentPageQuery.parse(r.query).cursor),
    ),
  );
  app.post('/assessment-forms', { ...manage, ...limited }, async (r, reply) =>
    reply
      .code(201)
      .send(
        AssessmentForm.parse(
          await service.create(r, authOf(r), CreateAssessmentForm.parse(r.body)),
        ),
      ),
  );
  app.post('/assessment-forms/:id/archive', { ...manage, ...limited }, async (r) =>
    AssessmentForm.parse(await service.archive(r, authOf(r), Id.parse(r.params).id)),
  );
  app.get('/patients/:id/assessments', doctor, async (r) =>
    PatientAssessments.parse(
      await service.list(
        r,
        authOf(r),
        Id.parse(r.params).id,
        AssessmentPageQuery.parse(r.query).cursor,
      ),
    ),
  );
  app.post('/patients/:id/assessments', { ...doctor, ...limited }, async (r, reply) =>
    reply
      .code(201)
      .send(
        PatientAssessment.parse(
          await service.assign(r, authOf(r), Id.parse(r.params).id, AssignAssessment.parse(r.body)),
        ),
      ),
  );
  app.post('/assessments/:id/cancel', { ...doctor, ...limited }, async (r) =>
    PatientAssessment.parse(await service.act(r, authOf(r), Id.parse(r.params).id)),
  );
  app.get('/portal/patients/:id/assessments', patient, async (r) =>
    PatientAssessments.parse(
      await service.list(
        r,
        authOf(r),
        Id.parse(r.params).id,
        AssessmentPageQuery.parse(r.query).cursor,
      ),
    ),
  );
  app.post('/portal/assessments/:id/submit', { ...patient, ...limited }, async (r) =>
    PatientAssessment.parse(
      await service.act(
        r,
        authOf(r),
        Id.parse(r.params).id,
        SubmitAssessment.parse(r.body).answers,
      ),
    ),
  );
};
