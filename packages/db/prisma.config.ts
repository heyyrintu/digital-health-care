import { defineConfig } from 'prisma/config';

// DATABASE_URL is the migration/owner connection. `prisma generate` does not connect,
// so a placeholder keeps generation working in CI without a database.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    url: process.env.DATABASE_URL ?? 'postgresql://placeholder@localhost:5432/placeholder',
  },
});
