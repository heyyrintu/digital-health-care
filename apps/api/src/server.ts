import { scheduleInbox } from './modules/whatsapp-inbox/dispatch';
import { schedulePatientRecordPurge } from './modules/patient-records/purge';
import { schedulePrepaidSweep } from './payments/prepaid';
import { buildApp } from './app';
import { corsOrigins, loadConfig, platformAllowlist, proxyTrust } from './config';
import { scheduleNoShowSweep } from './modules/appointments/no-shows';
import { samplePdf } from './modules/documents/document-samples';
import { checkPdfStartup } from './modules/documents/pdf-startup';
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

const stopInbox = scheduleInbox(services);
const stopRecordPurge = schedulePatientRecordPurge(services, app.log);
const stopPrepaid = schedulePrepaidSweep(services);
const stopSweep = scheduleNoShowSweep(services, config.NO_SHOW_SWEEP_SECONDS, app.log);

// Fail closed for broken PDF handling. A resource-constrained cold start may time out
// the known sample once; retry it finitely without changing upload processing limits.
const pdfStartup = checkPdfStartup(
  () => services.pdf.selfTest(samplePdf()),
  (attempt) =>
    app.log.warn({ attempt }, 'PDF startup sample timed out; retrying before serving traffic'),
);
void pdfStartup.then(
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
  await stopInbox();
  await stopPrepaid();
  await stopRecordPurge();
  await app.close();
  await services.db.$disconnect();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

try {
  if (config.NODE_ENV === 'production' && (await pdfStartup)) {
    throw new Error('PDF rebuild startup check failed; refusing production traffic.');
  }
  await app.listen({ host: config.API_HOST, port: config.API_PORT });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
