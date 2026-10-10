import fs from 'node:fs';

/** Runs once before all test files: fresh schema + seeds in ommis_test. */
export default async function setup(): Promise<void> {
  process.env.NODE_ENV = 'test';
  fs.rmSync('.storage/test', { recursive: true, force: true });
  // TEST_KEEP_DB=1: hosted DB (Supabase) - never drop it, only apply pending migrations.
  if (process.env.TEST_KEEP_DB === '1') {
    const { runMigrations, passwordFromUrl } = await import('../src/db/migrate');
    await runMigrations({ databaseUrl: process.env.DIRECT_URL ?? '', appPassword: passwordFromUrl(process.env.DATABASE_URL ?? ''), adminPassword: passwordFromUrl(process.env.ADMIN_DATABASE_URL ?? ''), ssl: process.env.DB_SSL === 'require', log: () => undefined });
  } else {
    const { resetDatabase } = await import('../src/db/reset');
    await resetDatabase(() => undefined);
  }
  const { runSeeds } = await import('../src/db/seeds/run');
  const { closeDb } = await import('../src/db/tenant');
  await runSeeds();
  await closeDb();
}
