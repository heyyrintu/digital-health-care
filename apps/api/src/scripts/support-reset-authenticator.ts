/**
 * Platform-support reset of a staff member's password and authenticator, for someone
 * who works at more than one clinic (a clinic admin can't reset them). Follow
 * docs/runbooks/support-authenticator-reset.md: verify identity and get approval first.
 *
 *   node dist/support-reset-authenticator.js --identifier doctor@example.test \
 *     --clinic clinic-a --ticket SUP-1234 --operator you@example.test \
 *     --reason "Lost phone; identity confirmed by callback"
 *
 * Shows what will happen and asks you to type RESET. --dry-run stops after the plan;
 * --yes skips the prompt (for a recorded, non-interactive session).
 */
import { createDb } from '@dhc/db';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { AppError } from '../errors';
import {
  supportResetAuthenticator,
  type SupportResetParams,
  type SupportResetResult,
} from '../modules/support/service';

const USAGE =
  'Usage: support-reset-authenticator --identifier <email|mobile> --clinic <slug> ' +
  '--ticket <id> --operator <name> --reason <text> [--dry-run] [--yes]';

const { values } = parseArgs({
  options: {
    identifier: { type: 'string' },
    clinic: { type: 'string' },
    ticket: { type: 'string' },
    operator: { type: 'string' },
    reason: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    yes: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

if (values.help) {
  console.error(USAGE);
  process.exit(0);
}
const required = ['identifier', 'clinic', 'ticket', 'operator', 'reason'] as const;
const missing = required.filter((k) => !values[k]);
if (missing.length > 0) fail(`Missing --${missing.join(', --')}.\n${USAGE}`);
const url = process.env.DATABASE_URL ?? fail('DATABASE_URL is required.');
const webBaseUrl = (process.env.WEB_BASE_URL ?? fail('WEB_BASE_URL is required.')).replace(
  /\/+$/,
  '',
);
const dryRun = values['dry-run'];
if (!dryRun && !values.yes && !process.stdin.isTTY) {
  fail('Refusing to reset without a terminal to confirm in. Pass --yes in a recorded session.');
}

const params: SupportResetParams = {
  identifier: values.identifier!,
  clinic: values.clinic!,
  ticket: values.ticket!,
  operator: values.operator!,
  reason: values.reason!,
};
const runId = `support-cli-${randomUUID()}`;
const source = { id: runId, ip: 'support-cli', headers: { 'user-agent': 'support-cli' } };
const db = createDb(url);
const deps = { db, webBaseUrl, now: () => new Date() };

function describe(plan: SupportResetResult) {
  console.error(`Staff member: ${plan.displayName ?? '(no name)'} <${plan.identifier}>`);
  console.error('Works at:');
  for (const c of plan.clinics) console.error(`  ${c.slug} (${c.name}): ${c.roles.join(', ')}`);
  console.error(`Reset link opens into: ${plan.linkClinic}`);
  console.error(`Staff sessions to sign out: ${plan.sessionsRevoked}`);
  console.error(`Open invite links to revoke: ${plan.invitesRevoked}`);
}

try {
  const plan = await supportResetAuthenticator(deps, source, { ...params, dryRun: true });
  describe(plan);
  if (dryRun) {
    console.error('\nDry run: nothing was changed.');
  } else {
    if (!values.yes) {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      const answer = await rl.question(
        '\nThis clears their password and authenticator for every clinic above. Type RESET to continue: ',
      );
      rl.close();
      if (answer.trim() !== 'RESET') fail('Cancelled: nothing was changed.');
    }
    const done = await supportResetAuthenticator(deps, source, params);
    console.error(
      `\nDone. ${done.sessionsRevoked} session(s) signed out; audit run ID ${runId} (ticket ${params.ticket}).`,
    );
    console.error(`Reset link (single use, expires ${done.expiresAt}):`);
    // The link alone goes to stdout, so it can be piped without the rest.
    process.stdout.write(`${done.inviteUrl}\n`);
    console.error(
      'Send it only to the verified contact on the ticket, by a different channel from the request. Never paste it into the ticket.',
    );
  }
} catch (error) {
  if (error instanceof AppError) fail(`Not reset: ${error.message}`);
  throw error;
} finally {
  await db.$disconnect();
}
