import { TunableSafetyRule } from '@dhc/contracts';
import { LOCKED_RULE_IDS, SAFETY_RULES } from '@dhc/safety';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('safety tuning', () => {
  it('lets clinics hide exactly the catalogue’s "Visibility only" rules', () => {
    const tunable = SAFETY_RULES.filter((r) => r.clinicTuning === 'visibility_only').map(
      (r) => r.id,
    );
    expect([...TunableSafetyRule.options].sort()).toEqual([...tunable].sort());
    for (const id of TunableSafetyRule.options) {
      expect(LOCKED_RULE_IDS).not.toContain(id);
      expect(SAFETY_RULES.find((r) => r.id === id)?.severity).not.toBe('block');
    }
  });

  it('has the same list in the database check', () => {
    const sql = readFileSync(
      new URL(
        '../../../../../packages/db/prisma/migrations/20261008150000_organisation_settings/migration.sql',
        import.meta.url,
      ),
      'utf8',
    );
    const listed = /hidden_safety_rules <@ ARRAY\[([^\]]*)\]/.exec(sql)?.[1] ?? '';
    expect(listed.match(/SR-\d+/g)?.sort()).toEqual([...TunableSafetyRule.options].sort());
  });
});
