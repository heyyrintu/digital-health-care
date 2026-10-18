import { atom, read, update } from 'claude-code';
import type { EngineInterface, Register } from 'claude-code';

import type { CheckRun, CheckStep, PlanPhase } from '../types';
import {
  PLAN_PATH,
  cleanFilter,
  currentPhase,
  isMigrationFile,
  parseProgress,
  pushProblem,
  tail,
} from './plan';

const PANE = 'dhc-steward';
const PLUGIN = 'dhc-steward';
const TOOL_PLAN = `mcp__${PLUGIN}__plan_status`;
const TOOL_CHECKS = `mcp__${PLUGIN}__run_checks`;

const phases = atom({ plugin: 'dhc-steward', key: 'phases' } as const, []);
const lastCheck = atom({ plugin: 'dhc-steward', key: 'lastCheck' } as const, null);
const busy = atom({ plugin: 'dhc-steward', key: 'busy' } as const, null);

const RULES = [
  'Digital Healthcare monorepo rules (from README and docs/product/build-plan.md):',
  '- Work toward the build plan (docs/product/build-plan.md §9.1); the current phase and its exit criteria decide what comes next.',
  '- Apps never import each other; shared code lives in packages/. Contracts in @dhc/contracts (Zod) are the API source of truth.',
  '- Every request runs under row-level security via withTenant / withAuth; never bypass tenancy.',
  '- Applied migrations are never edited: add a new folder under packages/db/prisma/migrations.',
  '- A change in behaviour updates the matching document in docs/ (and the §9.1 progress table) in the same pull request.',
  '- Never put real patient data in code, tests, fixtures or logs: use the synthetic personas in docs/qa/test-plan.md.',
  '- Definition of done: tests written, en and hi strings added, audit events logged, docs updated, `pnpm check` green.',
  `- Before a push, run the ${TOOL_CHECKS} tool (format, lint, typecheck, test, build) and fix what fails.`,
].join('\n');

const BUILDER = [
  'You build one slice of the Digital Healthcare platform (pnpm + Turborepo monorepo: apps/api Fastify, apps/web Next.js,',
  'apps/mobile Expo, packages/* shared). You are given one well-scoped task from the build plan.',
  'Read the relevant docs (docs/product/build-plan.md, ADRs in docs/adr, docs/api, docs/data/data-dictionary.md) and the',
  'neighbouring code first, and write code that reads like it. Add contracts in packages/contracts, migrations as new',
  'folders, unit tests beside the code, en/hi strings in packages/i18n, audit events for state changes, and update docs.',
  'Run `pnpm turbo run lint typecheck test --filter=<package>...` for what you touched. Do not commit or push:',
  'report the files you changed, the checks you ran with their results, and anything left open.',
].join(' ');

const REVIEWER = [
  'You review a change to the Digital Healthcare monorepo before it is pushed. Read `git diff` against the base branch.',
  'Look for: tenancy leaks (queries outside withTenant/withAuth, cross-clinic references), missing authorisation per role,',
  'safety-engine or signing regressions, edited applied migrations, real-looking patient data, missing tests, missing',
  'en/hi strings, missing audit events, and docs not updated for changed behaviour. Report concrete findings with',
  'file:line and a suggested fix, most severe first. Do not edit files.',
].join(' ');

type Engine = EngineInterface;

async function loadPlan($: Engine): Promise<PlanPhase[]> {
  const root = await $.session.cwd();
  const text = await $.fs.read(`${root}/${PLAN_PATH}`);
  const list = parseProgress(text);
  await update($, phases, () => list);
  return list;
}

async function runChecks($: Engine, filter: string | null): Promise<CheckRun> {
  await update($, busy, () => (filter ? `checks on ${filter}` : 'checks'));
  $.ui.status('dhc: checks running');
  const steps: CheckStep[] = [];
  const root = await $.session.cwd();
  const isInstalled = await $.fs.exists(`${root}/node_modules`);
  const plan: { name: string; argv: string[] }[] = [
    ...(isInstalled ? [] : [{ name: 'install', argv: ['pnpm', 'install', '--frozen-lockfile'] }]),
    { name: 'format', argv: ['pnpm', 'format:check'] },
    {
      name: 'lint typecheck test build',
      argv: [
        'pnpm',
        'turbo',
        'run',
        'lint',
        'typecheck',
        'test',
        'build',
        ...(filter ? [`--filter=...${filter}`] : []),
      ],
    },
  ];
  try {
    for (const step of plan) {
      try {
        const ran = await $.process.run(step.argv, {
          timeoutMs: 600_000,
          env: { CI: '1', NEXT_TELEMETRY_DISABLED: '1', EXPO_NO_TELEMETRY: '1', FORCE_COLOR: '0' },
        });
        steps.push({
          name: step.name,
          exitCode: ran.exitCode,
          tail: tail(`${ran.stdout}\n${ran.stderr}`, 40),
        });
        if (ran.exitCode !== 0) break;
      } catch (error) {
        steps.push({ name: step.name, exitCode: 1, tail: String(error) });
        break;
      }
    }
  } finally {
    await update($, busy, () => null);
  }
  const run: CheckRun = {
    at: new Date().toISOString(),
    filter,
    isPassed: steps.length === plan.length && steps.every((step) => step.exitCode === 0),
    steps,
  };
  await update($, lastCheck, () => run);
  $.ui.status(
    run.isPassed ? 'dhc: checks green' : `dhc: ${steps[steps.length - 1]?.name ?? 'checks'} failed`,
  );
  return run;
}

function describeRun(run: CheckRun): string {
  const head = `Checks ${run.isPassed ? 'passed' : 'FAILED'}${run.filter ? ` (filter ${run.filter})` : ''} at ${run.at}.`;
  return [
    head,
    ...run.steps.map((step) =>
      step.exitCode === 0
        ? `- ${step.name}: ok`
        : `- ${step.name}: exit ${step.exitCode}\n${step.tail}`,
    ),
  ].join('\n');
}

function describePlan(list: readonly PlanPhase[]): string {
  if (list.length === 0) return `No progress table found under §9.1 in ${PLAN_PATH}.`;
  const now = currentPhase(list);
  return [
    `Build plan progress (${PLAN_PATH} §9.1):`,
    ...list.map((phase) => `- [${phase.status}] Phase ${phase.id} ${phase.name}: ${phase.state}`),
    now ? `Current phase: ${now.id} ${now.name}.` : 'Every phase is done.',
  ].join('\n');
}

function nextPrompt(list: readonly PlanPhase[], focus: string): string {
  const now = currentPhase(list);
  return [
    'Orchestrate the next increment of the Digital Healthcare build plan.',
    describePlan(list),
    focus ? `Focus requested by the person: ${focus}` : '',
    '',
    'Steps:',
    `1. Read ${PLAN_PATH} (§9.1 phase ${now ? now.id : ''} scope and exit criteria, §8 tests, §9.2 definition of done) and docs/release/CHANGELOG.md, then pick the next smallest increment that moves the current phase toward its exit criteria and is not built yet (check the code, not only the docs). A **Priority** note above the §9.1 progress table orders the work and wins over phase order: follow it first.`,
    '2. Split it into independent slices (e.g. contracts + API module, web screen, mobile screen, docs). Write the plan as a short task list.',
    `3. Spawn one ${PLUGIN}:builder agent per independent slice, in parallel, each with a self-contained brief (files, contracts, acceptance). Do dependent slices in order.`,
    `4. Integrate their results, then call ${TOOL_CHECKS} and fix every failure until it is green.`,
    `5. Spawn a ${PLUGIN}:reviewer agent on the diff; fix the real findings and re-run ${TOOL_CHECKS}.`,
    `6. Update the docs the change affects, the §9.1 progress table in ${PLAN_PATH}, and docs/release/CHANGELOG.md.`,
    '7. Commit with a clear message on the working branch, push it, and open or update a draft pull request.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'dhc',
      description: 'Show the build plan, checks and actions for this repo',
    });
    await $.command.register({
      name: 'dhc-check',
      description: 'Run format, lint, typecheck, test and build (optionally for one package)',
      argumentHint: '[package, e.g. @dhc/web]',
    });
    await $.command.register({
      name: 'dhc-next',
      description:
        'Plan and build the next increment of the build plan with builder and reviewer agents',
      argumentHint: '[focus]',
    });
    await $.tool.register({
      name: 'plan_status',
      description: `Reports each build-plan phase and its state from ${PLAN_PATH} §9.1, and the current phase.`,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      isDeferred: false,
    });
    await $.tool.register({
      name: 'run_checks',
      description:
        "Runs the repo's checks as CI does: `pnpm format:check`, then `turbo run lint typecheck test build`, optionally filtered to one package and its dependents. Returns pass/fail and the tail of the failing step's output. Takes minutes.",
      inputSchema: {
        type: 'object',
        properties: {
          filter: {
            type: 'string',
            description: 'A workspace package, e.g. @dhc/web. Omit to check everything.',
          },
        },
        additionalProperties: false,
      },
      isDeferred: false,
    });
    await $.agent.register({
      name: 'builder',
      description:
        'Builds one well-scoped slice of the Digital Healthcare platform following the repo rules; does not commit.',
      prompt: BUILDER,
    });
    await $.agent.register({
      name: 'reviewer',
      description:
        'Reviews the current diff for tenancy, safety, migration, data and docs problems; read-only.',
      prompt: REVIEWER,
      disallowedTools: ['Edit', 'Write', 'NotebookEdit'],
    });
    try {
      const list = await loadPlan($);
      const now = currentPhase(list);
      if (now) $.ui.status(`dhc: phase ${now.id} ${now.name}`);
    } catch {
      // Not this repo, or the plan moved: the commands still say so when asked.
    }
    return next(e);
  });

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e);
    return {
      sections: [...composed.sections, { id: `${PLUGIN}:rules`, text: RULES, scope: 'session' }],
    };
  });

  on('command.run', { command: 'dhc' }, async ($) => {
    await loadPlan($).catch(() => []);
    await $.ui.open({ id: PANE, title: 'DHC build plan' });
    return { text: 'Build plan pane opened.' };
  });

  on('command.run', { command: 'dhc-check' }, async ($, e) => {
    const filter = cleanFilter(e.args);
    if (e.args.trim() !== '' && filter === null) return { text: `Not a package filter: ${e.args}` };
    const run = await runChecks($, filter);
    return { text: describeRun(run), context: [describeRun(run)] };
  });

  on('command.run', { command: 'dhc-next' }, async ($, e) => {
    const list = await loadPlan($).catch(() => [] as PlanPhase[]);
    await $.prompt.submit({ text: nextPrompt(list, e.args.trim()) });
    return { text: 'Queued the next build-plan increment for the model.' };
  });

  on('tool.call', { tool: 'mcp__dhc-steward__plan_status' }, async ($) => {
    const list = await loadPlan($);
    return { result: describePlan(list) };
  });

  on('tool.call', { tool: 'mcp__dhc-steward__run_checks' }, async ($, e) => {
    const raw = (e as { filter?: unknown }).filter;
    const filter = cleanFilter(typeof raw === 'string' ? raw : undefined);
    const run = await runChecks($, filter);
    return { result: describeRun(run) };
  });

  // Guards: applied migrations stay as they are, and main changes only through pull requests.
  on('tool.call', { tool: 'Edit' }, async ($, e, next) =>
    isMigrationFile(e.file_path)
      ? {
          deny: `${PLUGIN}: ${e.file_path} is an applied migration; add a new migration folder instead.`,
        }
      : next(e),
  ).catch(($, e, next) =>
    next.called ? next(e) : { deny: `${PLUGIN}: its migration guard failed.` },
  );

  on('tool.call', { tool: 'Write' }, async ($, e, next) =>
    isMigrationFile(e.file_path) && (await $.fs.exists(e.file_path))
      ? {
          deny: `${PLUGIN}: ${e.file_path} is an applied migration; add a new migration folder instead.`,
        }
      : next(e),
  ).catch(($, e, next) =>
    next.called ? next(e) : { deny: `${PLUGIN}: its migration guard failed.` },
  );

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const problem = pushProblem(e.command);
    return problem ? { deny: `${PLUGIN}: ${problem}.` } : next(e);
  }).catch(($, e, next) => (next.called ? next(e) : { deny: `${PLUGIN}: its push guard failed.` }));

  // Keep the pane in step when the plan document changes.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e);
    const path = (e as { file_path?: unknown }).file_path;
    if (
      (e.tool === 'Edit' || e.tool === 'Write') &&
      typeof path === 'string' &&
      path.endsWith(PLAN_PATH)
    ) {
      await loadPlan($).catch(() => undefined);
    }
    return ran;
  });

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e);
    const list = await read($, phases);
    const check = await read($, lastCheck);
    const running = await read($, busy);
    const now = currentPhase(list);
    const mark = { done: '✓', active: '▶', parked: '‖', todo: '·' } as const;

    return (
      <Box flexDirection="column">
        <Text bold>Build plan</Text>
        {list.length === 0 && <Text dimColor>No §9.1 progress table found.</Text>}
        {list.map((phase) => (
          <Text
            key={phase.id}
            dimColor={phase.status === 'todo' || phase.status === 'parked'}
            bold={phase === now}
          >
            {mark[phase.status]} {phase.id} {phase.name}
          </Text>
        ))}
        {now && <Text dimColor>{now.state.slice(0, 240)}</Text>}
        <Text> </Text>
        <Text bold>Checks</Text>
        {running ? (
          <Text>Running {running}…</Text>
        ) : check ? (
          <Text color={check.isPassed ? 'green' : 'red'}>
            {check.isPassed ? 'green' : 'red'}
            {check.filter ? ` (${check.filter})` : ''} · {check.at.slice(11, 16)} UTC
          </Text>
        ) : (
          <Text dimColor>Not run this session.</Text>
        )}
        {check && !check.isPassed && !running && (
          <Text dimColor>{tail(check.steps[check.steps.length - 1]?.tail ?? '', 8)}</Text>
        )}
        <Text> </Text>
        <Box flexDirection="row" gap={1}>
          <Button
            key="refresh"
            label="Refresh"
            hotkey="r"
            onPress={() => loadPlan($).then(() => undefined)}
          />
          <Button
            key="check"
            label="Run checks"
            hotkey="c"
            onPress={() => (running ? undefined : runChecks($, null).then(() => undefined))}
          />
          <Button
            key="next"
            label="Build next"
            hotkey="n"
            variant="primary"
            onPress={() => $.prompt.submit({ text: nextPrompt(list, '') }).then(() => undefined)}
          />
        </Box>
      </Box>
    );
  });
};
