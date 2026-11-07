import { expect, it } from 'vitest';
import { AssessmentDefinition, SubmitAssessment, scoreAssessment } from './assessments';
const definition = AssessmentDefinition.parse({
  title: 'Synthetic scale',
  questions: [
    { id: 'q1', label: 'First', min: 0, max: 10 },
    { id: 'q2', label: 'Second', min: 1, max: 5 },
  ],
});
it('validates unique questions, bounded integer ranges and immutable answer shape', () => {
  expect(
    AssessmentDefinition.safeParse({
      ...definition,
      questions: [definition.questions[0], definition.questions[0]],
    }).success,
  ).toBe(false);
  expect(
    AssessmentDefinition.safeParse({
      ...definition,
      questions: [{ id: 'bad', label: 'Bad', min: 4, max: 4 }],
    }).success,
  ).toBe(false);
  expect(SubmitAssessment.safeParse({ answers: { q1: 2.5, q2: 1 } }).success).toBe(false);
});
it('computes raw scores and rejects missing, extra or out-of-range answers', () => {
  expect(scoreAssessment(definition, { q1: 7, q2: 3 })).toEqual({
    answers: { q1: 7, q2: 3 },
    total: 10,
    minimum: 1,
    maximum: 15,
  });
  const invalid: Record<string, number>[] = [
    { q1: 7 },
    { q1: 7, q2: 6 },
    { q1: 7, q2: 3, other: 0 },
    { q1: 7, other: 1 },
  ];
  for (const answers of invalid) expect(() => scoreAssessment(definition, answers)).toThrow();
});
