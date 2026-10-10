import { exec } from '../../db/sql';
import { withTenant } from '../../db/tenant';
import { enqueue, registerHandler } from '../../jobs/boss';
import { QUEUES } from '../../jobs/queues';
import { addDays } from '../../lib/dates';
import { logger } from '../../lib/logger';
import { getBundle } from './engine.service';

/** Recomputes the plant (fresh bundle) and stores daily_derived from `fromDate` in batches of 500 rows. */
registerHandler(QUEUES.derivedRecalculate, async (data) => {
  const { tenantId, plantId, fromDate, pdfDate, pdfReason } = data as {
    tenantId: string; plantId: string; fromDate: string; pdfDate?: string; pdfReason?: string;
  };
  const b = await getBundle(tenantId, plantId);
  const from = fromDate < addDays(b.settings.plant.misStart, -1) ? addDays(b.settings.plant.misStart, -1) : fromDate;
  const rows = [...b.derived.entries()].filter(([d]) => d >= from);
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    await withTenant({ tenantId, actorId: null }, (tx) =>
      exec(tx,
        `INSERT INTO app.daily_derived (tenant_id, plant_id, d, vals, data_version)
         SELECT $1, $2, x.d, x.vals, $3 FROM jsonb_to_recordset($4::jsonb) AS x(d date, vals jsonb)
         ON CONFLICT (tenant_id, plant_id, d) DO UPDATE SET vals = EXCLUDED.vals, data_version = EXCLUDED.data_version, computed_at = now()`,
        [tenantId, plantId, b.dataVersion, JSON.stringify(chunk.map(([d, v]) => ({ d, vals: v })))]),
    );
  }
  logger.info({ tenantId, plantId, from, days: rows.length }, 'daily_derived recalculated');
  if (pdfDate) await enqueue(QUEUES.pdfGenerate, { tenantId, plantId, date: pdfDate, reason: pdfReason ?? 'submit' });
});
