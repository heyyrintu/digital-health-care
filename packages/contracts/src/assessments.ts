import { z } from 'zod';
export const AssessmentQuestion = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
    label: z.string().trim().min(1).max(240),
    labelHi: z.string().trim().max(240).default(''),
    min: z.number().int().min(0).max(10),
    max: z.number().int().min(1).max(10),
  })
  .strict()
  .refine((q) => q.min < q.max, { message: 'The maximum must exceed the minimum.' });
export const AssessmentDefinition = z
  .object({
    title: z.string().trim().min(1).max(120),
    titleHi: z.string().trim().max(120).default(''),
    instructions: z.string().trim().max(1200).default(''),
    instructionsHi: z.string().trim().max(1200).default(''),
    questions: z
      .array(AssessmentQuestion)
      .min(1)
      .max(20)
      .refine((q) => new Set(q.map((x) => x.id)).size === q.length, {
        message: 'Question IDs must be unique.',
      }),
  })
  .strict();
export type AssessmentDefinition = z.infer<typeof AssessmentDefinition>;
export const CreateAssessmentForm = z
  .object({ id: z.uuid(), definition: AssessmentDefinition })
  .strict();
export const AssessmentForm = z.object({
  id: z.uuid(),
  definition: AssessmentDefinition,
  active: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type AssessmentForm = z.infer<typeof AssessmentForm>;
export const AssessmentForms = z.object({
  data: z.array(AssessmentForm),
  nextCursor: z.string().nullable(),
});
export const AssessmentPageQuery = z.object({ cursor: z.uuid().optional() });
export const AssignAssessment = z.object({ id: z.uuid(), formId: z.uuid() }).strict();
export const AssessmentAnswers = z
  .record(z.string(), z.number().int().min(0).max(10))
  .refine((a) => Object.keys(a).length <= 20);
export const SubmitAssessment = z.object({ answers: AssessmentAnswers }).strict();
export const AssessmentResult = z.object({
  answers: AssessmentAnswers,
  total: z.number().int(),
  minimum: z.number().int(),
  maximum: z.number().int(),
});
export type AssessmentResult = z.infer<typeof AssessmentResult>;
export const PatientAssessment = z.object({
  id: z.uuid(),
  patientId: z.uuid(),
  formId: z.uuid(),
  definition: AssessmentDefinition,
  state: z.enum(['pending', 'submitted', 'cancelled']),
  createdAt: z.iso.datetime(),
  submittedAt: z.iso.datetime().nullable(),
  result: AssessmentResult.nullable(),
});
export type PatientAssessment = z.infer<typeof PatientAssessment>;
export const PatientAssessments = z.object({
  data: z.array(PatientAssessment),
  nextCursor: z.string().nullable(),
});
/** Raw sums only; interpretation and named/licensed scoring instruments are outside this schema. */
export function scoreAssessment(
  definition: AssessmentDefinition,
  answers: Record<string, number>,
): AssessmentResult {
  if (
    Object.keys(answers).length !== definition.questions.length ||
    definition.questions.some(
      (q) => !Number.isInteger(answers[q.id]) || answers[q.id]! < q.min || answers[q.id]! > q.max,
    )
  )
    throw new Error('Answer every question within its displayed range.');
  return {
    answers,
    total: definition.questions.reduce((n, q) => n + answers[q.id]!, 0),
    minimum: definition.questions.reduce((n, q) => n + q.min, 0),
    maximum: definition.questions.reduce((n, q) => n + q.max, 0),
  };
}

export type CreateAssessmentForm = z.infer<typeof CreateAssessmentForm>;
export type AssignAssessment = z.infer<typeof AssignAssessment>;
