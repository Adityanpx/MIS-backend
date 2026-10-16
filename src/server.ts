import { env } from './config/env';
import { initSentry } from './lib/sentry';
import { createApp } from './app';
import { closeDb, pingDb } from './db/tenant';
import { logger } from './lib/logger';
import { startJobs, stopJobs } from './jobs/boss';
import { drainEmails } from './modules/notifications/email.service';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry(label: string, fn: () => Promise<void>, tries = 6, delayMs = 3000) {
  for (let i = 1; ; i++) {
    try { return await fn(); }
    catch (err) {
      if (i >= tries) throw err;
      logger.warn({ err, label, attempt: i }, `${label} failed — retrying in ${delayMs}ms`);
      await sleep(delayMs);
    }
  }
}

async function main(): Promise<void> {
  initSentry();
  await withRetry('pingDb', pingDb);
  await withRetry('startJobs', startJobs);
  const app = createApp();
  const server = app.listen(env.PORT, () => logger.info({ port: env.PORT }, 'OMMIS API listening'));
  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    server.close(() => {
      stopJobs()
        .then(() => drainEmails()) // let background email sends finish (Step 9.6)
        .then(() => closeDb())
        .catch((err) => logger.error({ err }, 'Error during shutdown'))
        .finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 15_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Startup failed');
  process.exit(1);
});
