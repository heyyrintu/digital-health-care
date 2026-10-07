import type { TokenResponse } from '@dhc/contracts';
import { createDb, type Db } from '@dhc/db';
import { buildApp } from '../src/app';
import { hashPassword } from '../src/auth/password';
import { generateTotpSecret, totpAt } from '../src/auth/totp';
import { createServices, type Services } from '../src/services';

const JWT_SECRET = 'integration-test-secret-'.padEnd(48, 'x');
const FIELD_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString('base64');
export const STAFF_PASSWORD = 'synthetic-Passw0rd!';

/** A controllable clock: TOTP codes are single-use per 30 s step, so tests move time on. */
export class Clock {
  constructor(public ms = Date.UTC(2026, 9, 6, 4, 30)) {}
  now = () => new Date(this.ms);
  advance(seconds: number) {
    this.ms += seconds * 1000;
  }
}

export function createHarness() {
  const url = process.env.TEST_DATABASE_URL!;
  const clock = new Clock();
  const sentCodes: { phone: string; code: string }[] = [];
  const services: Services = createServices(
    {
      DATABASE_URL: url,
      JWT_SECRET,
      FIELD_ENCRYPTION_KEY,
      OTP_DELIVERY: 'disabled',
      WEB_BASE_URL: 'https://app.test',
    } as Parameters<typeof createServices>[0],
    {
      otpSender: { send: async (phone, code) => void sentCodes.push({ phone, code }) },
      now: clock.now,
    },
  );
  const app = buildApp({
    config: {
      LOG_LEVEL: (process.env.TEST_LOG_LEVEL as 'silent') ?? 'silent',
      APP_VERSION: 'test',
    },
    services,
    signInRateLimit: 1000,
  });
  /** Owner connection for arranging data and inspecting results (bypasses RLS). */
  const owner = createDb(url);
  return { app, services, owner, clock, sentCodes };
}

export type Harness = ReturnType<typeof createHarness>;

export async function resetDatabase(owner: Db) {
  await owner.$executeRawUnsafe(
    'TRUNCATE audit_logs, appointment_status_history, appointments, availability_exceptions, availability_versions, booking_rules, consultation_types, clinics, staff_invites, sessions, otp_challenges, memberships, patient_tags, tags, uhid_settings, patients, users, organisations CASCADE',
  );
}

export interface StaffFixture {
  userId: string;
  email: string;
  totpSecret: string;
}

/** Two organisations, each with a doctor, a clinic admin and synthetic patients. */
export async function seedTwoClinics(h: Harness) {
  const make = async (slug: string, name: string, patients: string[]) => {
    const org = await h.owner.organisation.create({ data: { slug, name } });
    const staff = (role: StaffRoleName, email: string) => addStaff(h, org.id, role, email);
    const doctor = await staff('doctor', `doctor@${slug}.test`);
    const admin = await staff('clinic_admin', `admin@${slug}.test`);
    const patientRows = await Promise.all(
      patients.map((patientName, i) =>
        h.owner.patient.create({
          data: {
            organisationId: org.id,
            uhid: `${slug.slice(0, 2).toUpperCase()}-${String(i + 1).padStart(6, '0')}`,
            name: patientName,
          },
        }),
      ),
    );
    return { org, doctor, admin, patients: patientRows };
  };
  const a = await make('clinic-a', 'Clinic A', ['Asha Verma', 'Kamla Devi']);
  const b = await make('clinic-b', 'Clinic B', ['Ravi Mehra', 'Imran Khan', 'Neha Kapoor']);
  return { a, b };
}

type StaffRoleName = 'doctor' | 'clinic_admin' | 'front_desk';

/** A signed-up staff member (password + authenticator) with an active membership. */
export async function addStaff(
  h: Harness,
  organisationId: string,
  role: StaffRoleName,
  email: string,
): Promise<StaffFixture> {
  const totpSecret = generateTotpSecret();
  const user = await h.owner.user.create({
    data: {
      email,
      passwordHash: await hashPassword(STAFF_PASSWORD),
      mfaSecret: h.services.cipher.encrypt(totpSecret),
    },
  });
  await h.owner.membership.create({ data: { organisationId, userId: user.id, role } });
  return { userId: user.id, email, totpSecret };
}

/** Full staff sign-in: password step, then a fresh TOTP code. */
export async function staffLogin(
  h: Harness,
  organisation: string,
  staff: StaffFixture,
): Promise<TokenResponse> {
  const login = await h.app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { organisation, identifier: staff.email, password: STAFF_PASSWORD },
  });
  if (login.statusCode !== 200) throw new Error(`login failed: ${login.body}`);
  h.clock.advance(30);
  const code = totpAt(staff.totpSecret, h.clock.ms / 1000);
  const verify = await h.app.inject({
    method: 'POST',
    url: '/v1/auth/mfa/verify',
    payload: { mfaToken: login.json().mfaToken, code },
  });
  if (verify.statusCode !== 200) throw new Error(`mfa failed: ${verify.body}`);
  return verify.json();
}

export const bearer = (tokens: TokenResponse) => ({
  authorization: `Bearer ${tokens.accessToken}`,
});
