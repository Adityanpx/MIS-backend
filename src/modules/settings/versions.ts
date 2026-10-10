import { exec, one } from '../../db/sql';
import type { Tx } from '../../db/tenant';
import { enqueue } from '../../jobs/boss';
import { QUEUES } from '../../jobs/queues';

/** Rule 5: every data/settings change bumps the plant's versions in the same transaction. */
export async function bumpVersions(
  tx: Tx, tenantId: string, plantId: string, kind: 'data' | 'settings' | 'both',
): Promise<{ dataVersion: number; settingsVersion: number }> {
  const r = await one<{ data_version: number; settings_version: number }>(
    tx,
    `INSERT INTO app.plant_data_versions (tenant_id, plant_id, data_version, settings_version)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, plant_id) DO UPDATE SET
       data_version = app.plant_data_versions.data_version + $3,
       settings_version = app.plant_data_versions.settings_version + $4
     RETURNING data_version, settings_version`,
    [tenantId, plantId, kind === 'settings' ? 0 : 1, kind === 'data' ? 0 : 1],
  );
  return { dataVersion: r.data_version, settingsVersion: r.settings_version };
}

/** PDF-05: PDFs for dates >= fromDate (excluding `exceptDate`) are now out of date. */
export async function markPdfsStale(
  tx: Tx, tenantId: string, plantId: string, fromDate: string, reason: string, exceptDate?: string,
): Promise<void> {
  await exec(
    tx,
    `UPDATE app.pdf_documents SET status = 'stale', reason = $4
      WHERE tenant_id = $1 AND plant_id = $2 AND d >= $3 AND status = 'current'
        AND ($5::date IS NULL OR d <> $5::date)`,
    [tenantId, plantId, fromDate, reason, exceptDate ?? null],
  );
}

/** Call AFTER commit: recompute daily_derived from `fromDate` (the job enqueues PDFs if asked). */
export async function requestRecalc(
  tenantId: string, plantId: string, fromDate: string, pdfDate?: string, pdfReason?: string,
): Promise<void> {
  await enqueue(QUEUES.derivedRecalculate, { tenantId, plantId, fromDate, pdfDate, pdfReason });
}
