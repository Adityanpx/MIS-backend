process.env.NODE_ENV = 'test';

// Every test file gets its own module instances (and therefore its own DB pools): close them at the end.
afterAll(async () => {
  const { drainJobs } = await import('../src/jobs/boss');
  await drainJobs();
  const { drainEmails } = await import('../src/modules/notifications/email.service');
  await drainEmails();
  const { closeDb } = await import('../src/db/tenant');
  await closeDb();
});
