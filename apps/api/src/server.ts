import { buildApp } from './app';
import { corsOrigins, loadConfig, platformAllowlist, proxyTrust } from './config';
import { scheduleNoShowSweep } from './modules/appointments/no-shows';
import { createServices } from './services';

const config = loadConfig();
const services = createServices(config);
const trust = proxyTrust(config);
const app = buildApp({
  config,
  services,
  trustProxy: trust,
  corsOrigins: corsOrigins(config),
  signInRateLimit: config.SIGN_IN_RATE_LIMIT,
  platformAllowlist: platformAllowlist(config),
});

// From the parsed value: a TRUSTED_PROXY_CIDRS of only commas or spaces trusts every peer.
if (trust && !trust.proxies) {
  app.log.warn(
    'TRUST_PROXY_HOPS is set without TRUSTED_PROXY_CIDRS: safe only if the API port can be reached from the load balancer alone',
  );
}

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
