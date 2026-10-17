/**
 * Creates or disables a platform console operator (PRD §3.2). There is no HTTP route for
 * this. Follow docs/runbooks/platform-operators.md: approval on a ticket first, and the
 * new operator at the terminal with their authenticator app.
 *
 *   node dist/support-platform-operator.js --email ops@platform.example \
 *     --name "Ops Person" --ticket SUP-1234 --operator you@platform.example
 *
 * Asks the new operator to choose a password (not shown), shows a QR code for their
 * authenticator app and checks the first code before saving anything.
 *
 *   node dist/support-platform-operator.js --disable --email ops@platform.example \
 *     --ticket SUP-1235 --operator you@platform.example
 *
 * Disables the operator and ends their console sessions; asks you to type DISABLE
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
  normaliseOperatorEmail,
} from '../modules/platform/operators';

const USAGE =
  'Usage: support-platform-operator --email <email> --name <name> --ticket <id> --operator <you>\n' +
  '       support-platform-operator --disable --email <email> --ticket <id> --operator <you> [--yes]';

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    name: { type: 'string' },
    ticket: { type: 'string' },
    operator: { type: 'string' },
    disable: { type: 'boolean', default: false },
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
const required = values.disable
  ? (['email', 'ticket', 'operator'] as const)
  : (['email', 'name', 'ticket', 'operator'] as const);
const missing = required.filter((k) => !values[k]);
if (missing.length > 0) fail(`Missing --${missing.join(', --')}.\n${USAGE}`);
const url = process.env.DATABASE_URL ?? fail('DATABASE_URL is required.');
if (!process.stdin.isTTY && !(values.disable && values.yes)) {
  fail(
    values.disable
      ? 'Refusing to disable without a terminal to confirm in. Pass --yes in a recorded session.'
      : 'Creating an operator needs a terminal: they choose a password and scan a QR code.',
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

try {
  const email = normaliseOperatorEmail(values.email!);
  if (values.disable) {
    if (!values.yes) {
      const answer = await ask(`Disable ${email} and end their console sessions? Type DISABLE: `);
      if (answer !== 'DISABLE') fail('Cancelled: nothing was changed.');
    }
    const done = await disablePlatformOperator({ db, now }, source, { ...trail, email });
    console.error(
      `Disabled; ${done.sessionsRevoked} session(s) ended. Audit run ID ${runId} (ticket ${trail.ticket}).`,
    );
  } else {
    const key =
      process.env.FIELD_ENCRYPTION_KEY ??
      fail('FIELD_ENCRYPTION_KEY is required (as for the API).');
    const cipher = new FieldCipher(key);
    console.error(`New platform operator: ${values.name} <${email}>`);
    console.error('The new operator types their password now (at least 12 characters).');
    const password = await ask('Password: ', true);
    if ((await ask('Again: ', true)) !== password) fail('The passwords differ: nothing was saved.');

    const secret = generateTotpSecret();
    const uri = otpauthUri(PLATFORM_TOTP_ISSUER, email, secret);
    console.error('\nScan this with the authenticator app (or type the key):\n');
    console.error(await QRCode.toString(uri, { type: 'terminal', small: true }));
    console.error(`Key: ${secret}\n`);
    let confirmed = false;
    for (let attempt = 0; attempt < 3 && !confirmed; attempt++) {
      const code = await ask('Code from the app: ');
      confirmed = matchTotpStep(secret, code, Date.now()) !== null;
      if (!confirmed) console.error('That code does not match. Check the app and try again.');
    }
    if (!confirmed) fail('No matching code: nothing was saved.');

    const created = await createPlatformOperator({ db, now, cipher }, source, {
      ...trail,
      email,
      displayName: values.name!,
      password,
      totpSecret: secret,
    });
    console.error(
      `\nCreated operator ${created.email}; audit run ID ${runId} (ticket ${trail.ticket}).`,
    );
  }
} catch (error) {
  if (error instanceof AppError) fail(`Nothing was changed: ${error.message}`);
  throw error;
} finally {
  rl.close();
  await db.$disconnect();
}
