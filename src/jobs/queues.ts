export const QUEUES = {
  derivedRecalculate: 'derived.recalculate',
  pdfGenerate: 'pdf.generate',
  pdfZip: 'pdf.zip',
  importValidate: 'import.validate',
  importApply: 'import.apply',
  exportLogsheets: 'export.logsheets',
  emailRetry: 'email.retry',
  logsheetMissing: 'logsheet.missing',
  remindersExpiry: 'reminders.expiry',
  breakdownAgeing: 'breakdown.ageing',
  // Phase 3
  invoicesGenerate: 'invoices.generate',
  pdfInvoice: 'pdf.invoice',
  razorpayLinkCreate: 'razorpay.link.create',
  razorpayReconcile: 'razorpay.reconcile',
  lifecycleEvaluate: 'lifecycle.evaluate',
  remindersBilling: 'reminders.billing',
  usageSnapshot: 'usage.snapshot',
  exportClient: 'export.client',
  deletionQueue: 'deletion.queue',
  clientDelete: 'client.delete',
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export const QUEUE_OPTIONS: Record<QueueName, { concurrency: number; retryLimit: number }> = {
  'derived.recalculate': { concurrency: 2, retryLimit: 3 },
  'pdf.generate': { concurrency: 1, retryLimit: 3 },
  'pdf.zip': { concurrency: 1, retryLimit: 1 },
  'import.validate': { concurrency: 1, retryLimit: 1 },
  'import.apply': { concurrency: 1, retryLimit: 1 },
  'export.logsheets': { concurrency: 1, retryLimit: 1 },
  'email.retry': { concurrency: 1, retryLimit: 1 },
  'logsheet.missing': { concurrency: 1, retryLimit: 3 },
  'reminders.expiry': { concurrency: 1, retryLimit: 3 },
  'breakdown.ageing': { concurrency: 1, retryLimit: 3 },
  'invoices.generate': { concurrency: 1, retryLimit: 3 },
  'pdf.invoice': { concurrency: 1, retryLimit: 3 },
  'razorpay.link.create': { concurrency: 2, retryLimit: 5 },
  'razorpay.reconcile': { concurrency: 1, retryLimit: 3 },
  'lifecycle.evaluate': { concurrency: 1, retryLimit: 3 },
  'reminders.billing': { concurrency: 1, retryLimit: 3 },
  'usage.snapshot': { concurrency: 1, retryLimit: 3 },
  'export.client': { concurrency: 1, retryLimit: 1 },
  'deletion.queue': { concurrency: 1, retryLimit: 3 },
  'client.delete': { concurrency: 1, retryLimit: 2 },
};

/** Jobs that GitHub Actions cron may trigger through POST /internal/cron/:job. */
export const CRON_JOBS: QueueName[] = [
  'email.retry', 'logsheet.missing', 'reminders.expiry', 'breakdown.ageing',
  'invoices.generate', 'lifecycle.evaluate', 'razorpay.reconcile', 'reminders.billing', 'usage.snapshot', 'deletion.queue',
];
