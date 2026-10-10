import { registerHandler } from '../../jobs/boss';
import { QUEUES } from '../../jobs/queues';
import { logger } from '../../lib/logger';
import { generateDueInvoices } from './invoices.service';

/** Cron (00:30 IST) with no data = everything due; with { tenantId } or { subscriptionId } = right after a create/renew. */
registerHandler(QUEUES.invoicesGenerate, async (data) => {
  const r = await generateDueInvoices({
    tenantId: typeof data.tenantId === 'string' ? data.tenantId : undefined,
    subscriptionId: typeof data.subscriptionId === 'string' ? data.subscriptionId : undefined,
  });
  logger.info(r, 'invoices.generate done');
});
