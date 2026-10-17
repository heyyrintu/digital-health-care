/**
 * Browser tests only (apps/e2e): creates a platform operator with the same
 * `createPlatformOperator` the support command calls, without its terminal prompts, so a
 * Playwright test can sign in to the console. There is still no HTTP route for this, and
 * this file is not part of the API build (tsup bundles `src/` entries only).
 *
 * The e2e harness runs it with `tsx` and passes everything through the environment:
 * DATABASE_URL, FIELD_ENCRYPTION_KEY, and E2E_OPERATOR_EMAIL, E2E_OPERATOR_NAME,
 * E2E_OPERATOR_PASSWORD and E2E_OPERATOR_TOTP_KEY (base32). Prints `{"id","email"}`.
 * Refuses to run unless NODE_ENV=test.
 */
import { createDb } from '@dhc/db';
import { FieldCipher } from '../src/auth/field-cipher';
import { createPlatformOperator } from '../src/modules/platform/operators';

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

if (process.env.NODE_ENV !== 'test') fail('seed-platform-operator runs only with NODE_ENV=test.');
// An empty value counts as missing, so a blank variable never becomes an empty password or key.
const env = (name: string) => process.env[name]?.trim() || fail(`${name} is required.`);
// Passwords are kept as typed (sign-in never trims them): only an empty one is refused.
const raw = (name: string) => process.env[name] || fail(`${name} is required.`);

const db = createDb(env('DATABASE_URL'));
try {
  const now = () => new Date();
  const created = await createPlatformOperator(
    { db, now, cipher: new FieldCipher(env('FIELD_ENCRYPTION_KEY')) },
    { id: 'e2e-seed', ip: 'e2e-seed', headers: { 'user-agent': 'e2e-seed' } },
    {
      ticket: 'E2E-SEED',
      operator: 'e2e harness',
      email: env('E2E_OPERATOR_EMAIL'),
      displayName: env('E2E_OPERATOR_NAME'),
      password: raw('E2E_OPERATOR_PASSWORD'),
      totpSecret: env('E2E_OPERATOR_TOTP_KEY'),
      // As if enrolled with the previous period's code: the current code signs in.
      confirmedStep: Math.floor(Date.now() / 30_000) - 1,
    },
  );
  process.stdout.write(`${JSON.stringify(created)}\n`);
} finally {
  await db.$disconnect();
}
