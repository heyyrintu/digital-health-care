/** Synthetic browser-test setup: use the actual request service and capture, never send, its code. */
import { loadConfig } from '../src/config';
import { createServices } from '../src/services';
import { PeopleService } from '../src/modules/staff/people';
import { StaffContactService } from '../src/modules/staff/contact-changes';
import type { FastifyRequest } from 'fastify';
let code = '';
const services = createServices(
  loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: process.env.E2E_DATABASE_URL,
    JWT_SECRET: process.env.E2E_JWT_SECRET,
    FIELD_ENCRYPTION_KEY: process.env.E2E_FIELD_ENCRYPTION_KEY,
  }),
  {
    emailSender: {
      sendVerification: async (_email, value) => {
        code = value;
      },
    },
  },
);
try {
  const org = await services.db.organisation.findUniqueOrThrow({
    where: { slug: process.env.E2E_CONTACT_CLINIC! },
  });
  const user = await services.db.user.findUniqueOrThrow({
    where: { email: `doctor@${org.slug}.test` },
  });
  const admin = await services.db.user.findUniqueOrThrow({
    where: { email: `clinic_admin@${org.slug}.test` },
  });
  const session = await services.db.session.findFirstOrThrow({
    where: { userId: admin.id, organisationId: org.id, role: 'clinic_admin', revokedAt: null },
    orderBy: { createdAt: 'desc' },
  });
  const actor = { userId: admin.id, organisationId: org.id, sessionId: session.id };
  const person = await new PeopleService(services).get(actor, user.id);
  const destination = `verified-doctor@${org.slug}.test`;
  const change = await new StaffContactService(services).request(
    { id: 'req_browser_contact_seed', ip: '127.0.0.1', headers: {} } as FastifyRequest,
    actor,
    user.id,
    {
      version: person.version,
      field: 'email',
      value: destination,
      password: 'admin synthetic passphrase',
    },
  );
  process.stdout.write(JSON.stringify({ id: change.id, code, destination }));
} finally {
  await services.db.$disconnect();
}
