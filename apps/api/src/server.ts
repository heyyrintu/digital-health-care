import { buildApp } from './app';
import { corsOrigins, loadConfig } from './config';
import { scheduleNoShowSweep } from './modules/appointments/no-shows';
import { createServices } from './services';

const config = loadConfig();
const services = createServices(config);
const app = buildApp({
  config,
  services,
  trustProxy: config.NODE_ENV === 'production',
  corsOrigins: corsOrigins(config),
  signInRateLimit: config.SIGN_IN_RATE_LIMIT,
});

const stopSweep = scheduleNoShowSweep(services, config.NO_SHOW_SWEEP_SECONDS, app.log);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'Shutting down');
  stopSweep();
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
