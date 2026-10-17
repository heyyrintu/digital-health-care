/**
 * Creates, disables, enables or re-enrols a platform console operator (PRD §3.2). There is
 * no HTTP route for any of this. Follow docs/runbooks/platform-operators.md: approval on a
 * ticket first, and for create or reset the operator at the terminal with their phone.
 *
 *   node dist/support-platform-operator.js --email ops@platform.example \
 *     --name "Ops Person" --ticket SUP-1234 --operator you@platform.example
 *
 * Asks the new operator to choose a password (not shown), then, once the session
 * recording is paused, shows a QR code for their authenticator app and checks the first
 * code before saving anything. The typed key is printed only with --show-key.
 *
 *   node dist/support-platform-operator.js --reset-authenticator --email ops@platform.example \
 *     --ticket SUP-1236 --operator you@platform.example
 *
 * Enrols a new authenticator the same way (lost or replaced phone) and ends their sessions.
 *
 *   node dist/support-platform-operator.js --disable --email … --ticket … --operator …
 *   node dist/support-platform-operator.js --enable --email … --ticket … --operator …
 *
 * Disable ends the operator's sessions at once. Both ask you to type the action's name
 * (--yes skips the prompt in a recorded, non-interactive session).
 */
import { createDb } from '@dhc/db';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import QRCode from 'qrcode';
import { FieldCipher } from '../auth/field-cipher';
import { generateTotpSecret, matchTotpStep, otpauthUri } from '../auth/totp';
import { AppError } from '../errors';
import {
  PLATFORM_TOTP_ISSUER,
  createPlatformOperator,
  disablePlatformOperator,
  enablePlatformOperator,
  normaliseOperatorEmail,
  resetPlatformOperatorAuthenticator,
} from '../modules/platform/operators';

const USAGE =
  'Usage: support-platform-operator --email <email> --name <name> --ticket <id> --operator <you> [--show-key]\n' +
  '       support-platform-operator --reset-authenticator --email <email> --ticket <id> --operator <you> [--show-key]\n' +
  '       support-platform-operator --disable|--enable --email <email> --ticket <id> --operator <you> [--yes]';

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    name: { type: 'string' },
    ticket: { type: 'string' },
    operator: { type: 'string' },
    disable: { type: 'boolean', default: false },
    enable: { type: 'boolean', default: false },
    'reset-authenticator': { type: 'boolean', default: false },
    'show-key': { type: 'boolean', default: false },
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
const modes = (['disable', 'enable', 'reset-authenticator'] as const).filter((m) => values[m]);
if (modes.length > 1) fail(`Choose one of --disable, --enable, --reset-authenticator.\n${USAGE}`);
const mode = modes[0] ?? 'create';
const required =
  mode === 'create'
    ? (['email', 'name', 'ticket', 'operator'] as const)
    : (['email', 'ticket', 'operator'] as const);
const missing = required.filter((k) => !values[k]);
if (missing.length > 0) fail(`Missing --${missing.join(', --')}.\n${USAGE}`);
const url = process.env.DATABASE_URL ?? fail('DATABASE_URL is required.');
const enrols = mode === 'create' || mode === 'reset-authenticator';
if (!process.stdin.isTTY && (enrols || !values.yes)) {
  fail(
    enrols
      ? 'This needs a terminal: the operator types a password or scans a QR code.'
      : 'Refusing to change an operator without a terminal to confirm in. Pass --yes in a recorded session.',
  );
}

const runId = `support-cli-${randomUUID()}`;
const source = { id: runId, ip: 'support-cli', headers: { 'user-agent': 'support-cli' } };
const db = createDb(url);
const now = () => new Date();
const trail = { ticket: values.ticket!, operator: values.operator! };

// Typed passwords are not echoed: readline writes through this, muted while one is typed.
let muted = false;
const output = new Writable({
  write(chunk, encoding, done) {
    if (!muted) process.stderr.write(chunk, encoding);
    done();
  },
});
const rl = createInterface({ input: process.stdin, output, terminal: process.stdin.isTTY });
async function ask(question: string, hidden = false): Promise<string> {
  process.stderr.write(question);
  muted = hidden;
  const answer = await rl.question('');
  muted = false;
  if (hidden) process.stderr.write('\n');
  return answer.trim();
}

/**
 * Shows the QR code (only while the recording is paused) and checks a code from the app.
 * Returns the secret and the confirming code's step, which can then never sign in.
 */
async function enrol(email: string): Promise<{ secret: string; step: number }> {
  const secret = generateTotpSecret();
  const uri = otpauthUri(PLATFORM_TOTP_ISSUER, email, secret);
  console.error(
    '\nThe QR code holds the authenticator secret: it must not be in the session recording.',
  );
  await ask('Pause the recording now, then press Enter to show the QR code. ');
  console.error('\nScan this with the authenticator app:\n');
  console.error(await QRCode.toString(uri, { type: 'terminal', small: true }));
  // The typed key is the same secret in text: only when the app cannot scan.
  if (values['show-key']) console.error(`Key: ${secret}\n`);
  let step: number | null = null;
  for (let attempt = 0; attempt < 3 && step === null; attempt++) {
    step = matchTotpStep(secret, await ask('Code from the app: '), Date.now());
    if (step === null) console.error('That code does not match. Check the app and try again.');
  }
  // Clear the screen so the code does not stay on it when the recording resumes.
  process.stderr.write('\x1b[2J\x1b[3J\x1b[H');
  if (step === null) fail('No matching code: nothing was saved.');
  console.error('Authenticator confirmed. You can resume the recording.');
  return { secret, step: step! };
}

async function confirm(action: string, word: string) {
  if (values.yes) return;
  const answer = await ask(`${action} Type ${word}: `);
  if (answer !== word) fail('Cancelled: nothing was changed.');
}

try {
  const email = normaliseOperatorEmail(values.email!);
  const done = `audit run ID ${runId} (ticket ${trail.ticket})`;
  if (mode === 'disable') {
    await confirm(`Disable ${email} and end their console sessions?`, 'DISABLE');
    const result = await disablePlatformOperator({ db, now }, source, { ...trail, email });
    console.error(`Disabled; ${result.sessionsRevoked} session(s) ended; ${done}.`);
  } else if (mode === 'enable') {
    await confirm(`Let ${email} sign in to the platform console again?`, 'ENABLE');
    const result = await enablePlatformOperator({ db, now }, source, { ...trail, email });
    console.error(result.alreadyActive ? 'Already active: nothing changed.' : `Enabled; ${done}.`);
  } else {
    const key =
      process.env.FIELD_ENCRYPTION_KEY ??
      fail('FIELD_ENCRYPTION_KEY is required (as for the API).');
    const cipher = new FieldCipher(key);
    if (mode === 'reset-authenticator') {
      console.error(`New authenticator for ${email}; their console sessions will end.`);
      const { secret, step } = await enrol(email);
      const result = await resetPlatformOperatorAuthenticator({ db, now, cipher }, source, {
        ...trail,
        email,
        totpSecret: secret,
        confirmedStep: step,
      });
      console.error(`Authenticator replaced; ${result.sessionsRevoked} session(s) ended; ${done}.`);
    } else {
      console.error(`New platform operator: ${values.name} <${email}>`);
      console.error('The new operator types their password now (at least 12 characters).');
      const password = await ask('Password: ', true);
      if ((await ask('Again: ', true)) !== password) {
        fail('The passwords differ: nothing was saved.');
      }
      const { secret, step } = await enrol(email);
      const created = await createPlatformOperator({ db, now, cipher }, source, {
        ...trail,
        email,
        displayName: values.name!,
        password,
        totpSecret: secret,
        confirmedStep: step,
      });
      console.error(`\nCreated operator ${created.email}; ${done}.`);
    }
  }
} catch (error) {
  if (error instanceof AppError) fail(`Nothing was changed: ${error.message}`);
  throw error;
} finally {
  rl.close();
  await db.$disconnect();
}
