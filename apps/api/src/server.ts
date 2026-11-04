import { buildApp } from './app';
import { corsOrigins, loadConfig, platformAllowlist, proxyTrust } from './config';
import { scheduleNoShowSweep } from './modules/appointments/no-shows';
import { samplePdf } from './modules/documents/document-samples';
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

// Rebuild a sample PDF once: a missing worker file or a pdf-lib that can no longer be capped
// would otherwise show up only as refused uploads (threat model T27).
void services.pdf.selfTest(samplePdf()).then(
  (problem) => {
    if (problem)
      app.log.error({ problem }, 'PDF rebuild self-test failed: PDF uploads will be refused');
    else app.log.info('PDF rebuild self-test passed');
  },
  (err: unknown) => app.log.error({ err }, 'PDF rebuild self-test failed'),
);

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
