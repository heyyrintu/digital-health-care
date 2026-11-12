import { expect, it } from 'vitest';
import { assertJsonBudget, jsonBudget } from './json-budget';
it('counts shared references repeatedly and stops before huge JSON serialization', () => {
  const shared = { text: 'X'.repeat(100_000) };
  expect(() => assertJsonBudget(Array(200_000).fill(shared), 1024)).toThrow('budget');
  expect(jsonBudget([shared, shared], 1024 * 1024)).toBeGreaterThan(
    jsonBudget(shared, 1024 * 1024) * 2,
  );
});
