import { expect, test } from 'claude-code/testing';

test('the push guard refuses main and lets a branch push through', async ($, on) => {
  on(
    'tool.call',
    { tool: 'Bash' },
    () => ({ result: { stdout: 'pushed', stderr: '', interrupted: false } }) as never,
  );

  const toMain = await $.tool.call({ tool: 'Bash', command: 'git push origin main' });
  expect(toMain.deny).toContain('pull request');

  const toBranch = await $.tool.call({ tool: 'Bash', command: 'git push -u origin feature/x' });
  expect(toBranch.deny).toBeUndefined();
});

test('the migration guard refuses edits to an applied migration', async ($, on) => {
  on('tool.call', { tool: 'Edit' }, () => ({ result: 'edited' }) as never);

  const edit = await $.tool.call({
    tool: 'Edit',
    file_path: '/repo/packages/db/prisma/migrations/20261006184614_init/migration.sql',
    old_string: 'a',
    new_string: 'b',
  });
  expect(edit.deny).toContain('applied migration');

  const schema = await $.tool.call({
    tool: 'Edit',
    file_path: '/repo/packages/db/prisma/schema.prisma',
    old_string: 'a',
    new_string: 'b',
  });
  expect(schema.deny).toBeUndefined();
});
