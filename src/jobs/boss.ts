import PgBoss from 'pg-boss';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { captureError } from '../lib/sentry';
import { QUEUE_OPTIONS, type QueueName } from './queues';

type Handler = (data: Record<string, unknown>) => Promise<void>;
const handlers = new Map<QueueName, Handler>();
let boss: PgBoss | null = null;
const inlinePending = new Set<Promise<void>>();

/** Each job module registers its handler at import time (src/jobs/register.ts imports them all). */
export function registerHandler(queue: QueueName, handler: Handler): void {
  handlers.set(queue, handler);
}

/**
 * Enqueue AFTER the database transaction committed.
 * - boss:   durable job in Postgres (production)
 * - inline: run in-process in the background (tests; await drainJobs())
 * - off:    drop (only for scripts)
 */
export async function enqueue(queue: QueueName, data: Record<string, unknown>, opts: { singletonKey?: string; startAfterSec?: number } = {}): Promise<void> {
  if (env.JOBS_MODE === 'off') return;
  if (env.JOBS_MODE === 'inline') {
    const h = handlers.get(queue);
    if (!h) throw new Error(`No handler registered for ${queue}`);
    const p: Promise<void> = h(data)
      .catch((err) => {
        logger.error({ err, queue }, 'Inline job failed');
        captureError(err, { queue });
      })
      .finally(() => inlinePending.delete(p));
    inlinePending.add(p);
    return;
  }
  if (!boss) throw new Error('Job queue not started');
  await boss.send(queue, data, {
    retryLimit: QUEUE_OPTIONS[queue].retryLimit, retryDelay: 30, retryBackoff: true,
    singletonKey: opts.singletonKey, startAfter: opts.startAfterSec,
  });
}

/** Tests: wait until every inline job (and the jobs those jobs enqueued) has finished. */
export async function drainJobs(): Promise<void> {
  while (inlinePending.size > 0) await Promise.all([...inlinePending]);
}

/** Starts pg-boss (schema `pgboss`, owned by admin_user) and the workers. Called by server.ts. */
export async function startJobs(): Promise<void> {
  if (env.JOBS_MODE !== 'boss') return;
  boss = new PgBoss({
    connectionString: env.ADMIN_DATABASE_URL,
    schema: 'pgboss',
    ssl: env.DB_SSL === 'require' ? (env.DB_SSL_CA ? { ca: env.DB_SSL_CA } : { rejectUnauthorized: false }) : undefined,
    max: 3,
  });
  boss.on('error', (err) => logger.error({ err }, 'pg-boss error'));
  await boss.start();
  for (const [queue, handler] of handlers) {
    await boss.createQueue(queue);
    for (let i = 0; i < QUEUE_OPTIONS[queue].concurrency; i++) {
      await boss.work<Record<string, unknown>>(queue, { batchSize: 1 }, async (jobs) => {
        for (const job of jobs) {
          try {
            await handler(job.data);
          } catch (err) {
            captureError(err, { queue, jobId: job.id });
            throw err;
          }
        }
      });
    }
  }
  logger.info({ queues: [...handlers.keys()] }, 'Job workers started');
}

export async function stopJobs(): Promise<void> {
  await drainJobs();
  if (boss) await boss.stop({ graceful: true, timeout: 20_000 });
  boss = null;
}

/** /ready: true when jobs are not run by pg-boss here, or pg-boss is started and answering. */
export async function jobsHealthy(): Promise<boolean> {
  if (env.JOBS_MODE !== 'boss') return true;
  if (!boss) return false;
  try {
    await boss.getQueues();
    return true;
  } catch {
    return false;
  }
}
