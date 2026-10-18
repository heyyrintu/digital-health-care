import type { PlanPhase } from '../types';

export const PLAN_PATH = 'docs/product/build-plan.md';

/**
 * Reads the "Progress" table under build plan §9.1: one row per phase, its
 * first cell the phase ("1 Core clinic on web", or a range such as "3 to 6"),
 * its second what state the phase is in.
 */
export function parseProgress(markdown: string): PlanPhase[] {
  const start = markdown.search(/\*\*Progress[^*]*\*\*/);
  if (start < 0) return [];
  const phases: PlanPhase[] = [];
  let isInTable = false;
  for (const line of markdown.slice(start).split('\n').slice(1)) {
    const row = line.trim();
    if (!row.startsWith('|')) {
      if (isInTable) break;
      continue;
    }
    isInTable = true;
    const [phase = '', state = ''] = row
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (state === '' || /^:?-+:?$/.test(phase) || phase === 'Phase') continue;
    const match = /^(\d+(?:\s*to\s*\d+)?)\s*(.*)$/.exec(phase);
    phases.push({
      id: match?.[1] ?? phase,
      name: match?.[2] ? match[2] : '(later phases)',
      state,
      status: statusOf(state),
    });
  }
  return phases;
}

export function statusOf(state: string): PlanPhase['status'] {
  if (/^(done|exit criterion met)/i.test(state)) return 'done';
  if (/^not started/i.test(state)) return 'todo';
  if (/^parked/i.test(state)) return 'parked';
  return 'active';
}

/** The first phase in progress, else the first not started: the one /dhc-next builds toward. A parked phase waits. */
export function currentPhase(phases: readonly PlanPhase[]): PlanPhase | undefined {
  return (
    phases.find((phase) => phase.status === 'active') ??
    phases.find((phase) => phase.status === 'todo')
  );
}

const MIGRATION = /(^|\/)packages\/db\/prisma\/migrations\/[^/]+\/migration\.sql$/;

/** Applied migrations are history: a change goes in a new migration folder. */
export function isMigrationFile(path: string): boolean {
  return MIGRATION.test(path);
}

/** A push that would land on main directly, or rewrite a shared branch. */
export function pushProblem(command: string): string | undefined {
  for (const part of command.split(/&&|\|\||;|\n/)) {
    const words = part.trim().split(/\s+/);
    const at = words.indexOf('push');
    if (at < 1 || words[at - 1] !== 'git') continue;
    const rest = words.slice(at + 1);
    if (rest.some((word) => word === '--force' || word === '-f' || /^\+/.test(word))) {
      return 'force pushes are off here; use --force-with-lease on your own branch only when the repo rules allow it';
    }
    if (rest.some((word) => /^(HEAD:)?(refs\/heads\/)?(main|master)$/.test(word))) {
      return 'main only changes through a reviewed pull request';
    }
  }
  return undefined;
}

/** The last lines of a command's output, for a pane or a tool result. */
export function tail(text: string, lines: number): string {
  return text.trimEnd().split('\n').slice(-lines).join('\n');
}

/** A turbo `--filter` value: a package name such as `@dhc/web`, nothing else. */
export function cleanFilter(raw: string | undefined): string | null {
  const value = (raw ?? '').trim();
  if (value === '') return null;
  return /^[@\w./\-^.*\[\]!]+$/.test(value) ? value : null;
}
