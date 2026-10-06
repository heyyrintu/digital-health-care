import { buildApp } from './app';
import { corsOrigins, loadConfig } from './config';
import { createServices } from './services';

const config = loadConfig();
const app = buildApp({
  config,
  services: createServices(config),
  trustProxy: config.NODE_ENV === 'production',
  corsOrigins: corsOrigins(config),
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'Shutting down');
  await app.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

try {
  await app.listen({ host: config.API_HOST, port: config.API_PORT });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
