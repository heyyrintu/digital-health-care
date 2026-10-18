import { describe, expect, test } from 'claude-code/testing';

import { cleanFilter, currentPhase, isMigrationFile, parseProgress, pushProblem } from './plan';

const PLAN = `### 9.1 Phases and exit criteria

| Phase | Weeks |
|---|---|
| 0 Foundations | 1–4 |

**Progress (October 2026):**

| Phase | State |
|---|---|
| 0 Foundations | Done: monorepo, CI. |
| 1 Core clinic on web | Exit criterion met: the clinic day passes. |
| 2 Mobile apps | Starting: shared components. |
| 3 to 6 | Not started. |

### 9.2 Sprint rhythm
`;

describe('plan', () => {
  test('reads the progress table and finds the current phase', async () => {
    const phases = parseProgress(PLAN);
    expect(phases.map((phase) => phase.status)).toEqual(['done', 'done', 'active', 'todo']);
    expect(phases[3]?.name).toBe('(later phases)');
    expect(currentPhase(phases)?.id).toBe('2');
  });

  test('skips a parked phase', async () => {
    const phases = parseProgress(
      PLAN.replace(
        '| 2 Mobile apps | Starting',
        '| 2 Mobile apps | Parked (web first): starting',
      ).replace(
        '| 3 to 6 | Not started.',
        '| 3 Integrations | In progress: console. |\n| 4 to 6 | Not started.',
      ),
    );
    expect(phases.map((phase) => phase.status)).toEqual([
      'done',
      'done',
      'parked',
      'active',
      'todo',
    ]);
    expect(currentPhase(phases)?.id).toBe('3');
  });

  test('guards applied migrations', async () => {
    expect(
      isMigrationFile('/repo/packages/db/prisma/migrations/20261006184614_init/migration.sql'),
    ).toBe(true);
    expect(isMigrationFile('/repo/packages/db/prisma/schema.prisma')).toBe(false);
  });

  test('refuses pushes to main and force pushes', async () => {
    expect(pushProblem('git push origin main')).toBeDefined();
    expect(pushProblem('git add . && git push -f origin feature')).toBeDefined();
    expect(pushProblem('git push origin HEAD:main')).toBeDefined();
    expect(pushProblem('git push -u origin rintu/kind-mayer-olvjq3')).toBeUndefined();
    expect(pushProblem('echo push main')).toBeUndefined();
  });

  test('accepts only package filters', async () => {
    expect(cleanFilter('@dhc/web')).toBe('@dhc/web');
    expect(cleanFilter('  ')).toBe(null);
    expect(cleanFilter('x; rm -rf /')).toBe(null);
  });
});
