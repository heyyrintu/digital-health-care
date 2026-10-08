/**
 * Platform verification of a doctor's registration, so they can sign prescriptions
 * (PRD §9.1). Follow docs/runbooks/doctor-verification.md: check the council register
 * and the certificate first, and record it on the ticket.
 *
 *   node dist/support-verify-doctor.js --identifier doctor@example.test \
 *     --clinic clinic-a --ticket SUP-1234 --operator you@example.test
 *
 * Shows the details on the profile and asks you to type VERIFY. --dry-run stops after
 * showing them; --yes skips the prompt (for a recorded, non-interactive session).
 */
import { createDb } from '@dhc/db';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { AppError } from '../errors';
import { supportVerifyDoctor, type VerifyDoctorParams } from '../modules/support/verify-doctor';

const USAGE =
  'Usage: support-verify-doctor --identifier <email|mobile> --clinic <slug> ' +
  '--ticket <id> --operator <name> [--dry-run] [--yes]';

const { values } = parseArgs({
  options: {
    identifier: { type: 'string' },
    clinic: { type: 'string' },
    ticket: { type: 'string' },
    operator: { type: 'string' },
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
const required = ['identifier', 'clinic', 'ticket', 'operator'] as const;
const missing = required.filter((k) => !values[k]);
if (missing.length > 0) fail(`Missing --${missing.join(', --')}.\n${USAGE}`);
const url = process.env.DATABASE_URL ?? fail('DATABASE_URL is required.');
const dryRun = values['dry-run'];
if (!dryRun && !values.yes && !process.stdin.isTTY) {
  fail('Refusing to verify without a terminal to confirm in. Pass --yes in a recorded session.');
}

const params: VerifyDoctorParams = {
  identifier: values.identifier!,
  clinic: values.clinic!,
  ticket: values.ticket!,
  operator: values.operator!,
};
const runId = `support-cli-${randomUUID()}`;
const source = { id: runId, ip: 'support-cli', headers: { 'user-agent': 'support-cli' } };
const db = createDb(url);
const deps = { db, now: () => new Date() };

try {
  const plan = await supportVerifyDoctor(deps, source, { ...params, dryRun: true });
  console.error(
    `Doctor: ${plan.displayName ?? '(no name)'} <${plan.identifier}> at ${plan.clinic}`,
  );
  console.error(`Registration: ${plan.registrationNumber}, ${plan.council}`);
  console.error(`Qualifications: ${plan.qualifications}`);
  if (plan.alreadyVerified) {
    console.error('\nAlready verified: nothing to do.');
  } else if (dryRun) {
    console.error('\nDry run: nothing was changed.');
  } else {
    if (!values.yes) {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      const answer = await rl.question(
        '\nCheck these against the council register and the certificate. Type VERIFY to continue: ',
      );
      rl.close();
      if (answer.trim() !== 'VERIFY') fail('Cancelled: nothing was changed.');
    }
    await supportVerifyDoctor(deps, source, params);
    console.error(
      `\nVerified; audit run ID ${runId} (ticket ${params.ticket}). They can now sign.`,
    );
  }
} catch (error) {
  if (error instanceof AppError) fail(`Not verified: ${error.message}`);
  throw error;
} finally {
  await db.$disconnect();
}
