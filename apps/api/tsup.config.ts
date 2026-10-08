import { defineConfig } from 'tsup';

export default defineConfig({
  // The support commands ship with the server so operators can run it in production.
  entry: {
    server: 'src/server.ts',
    'support-reset-authenticator': 'src/scripts/support-reset-authenticator.ts',
    'support-verify-doctor': 'src/scripts/support-verify-doctor.ts',
  },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  clean: true,
  sourcemap: true,
  // Workspace packages ship TypeScript source, so bundle them into the build.
  noExternal: [/^@dhc\//],
});
