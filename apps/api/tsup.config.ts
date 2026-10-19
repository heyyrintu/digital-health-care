import { defineConfig } from 'tsup';

export default defineConfig({
  // The support commands ship with the server so operators can run them in production.
  entry: {
    server: 'src/server.ts',
    'support-reset-authenticator': 'src/scripts/support-reset-authenticator.ts',
    'support-verify-doctor': 'src/scripts/support-verify-doctor.ts',
    'support-platform-operator': 'src/scripts/support-platform-operator.ts',
    // Started as a worker thread by `pdf-rebuild.ts`, from beside the server.
    'pdf-rebuild-worker': 'src/modules/documents/pdf-rebuild-worker.ts',
  },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  clean: true,
  sourcemap: true,
  // Workspace packages ship TypeScript source, so bundle them into the build.
  noExternal: [/^@dhc\//],
});
