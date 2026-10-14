import { many, maybeOne } from '../../db/sql';
import { withSystem, type Tx } from '../../db/tenant';
import { registerHandler } from '../../jobs/boss';
import { QUEUES } from '../../jobs/queues';
import { formatDisplayDate, todayIST } from '../../lib/dates';
import { sendInBackground } from './email.service';
import { notify, plantRecipients } from './notify.service';

/** Same notification (code + link) is never sent twice: makes cron retries harmless (same pattern as alerts.jobs.ts). */
async function alreadySent(tx: Tx, tenantId: string, code: string, link: string) {
  return !!(await maybeOne(tx, 'SELECT 1 FROM app.notifications WHERE tenant_id = $1 AND template_code = $2 AND link = $3 LIMIT 1',
    [tenantId, code, link]));
}

/** N-O12/N-O13/N-O15: daily breakdown ageing sweep (§21.4A), run once a day. */
registerHandler(QUEUES.breakdownAgeing, async () => {
  const today = todayIST();
  const outbox: Array<string | null> = [];
  await withSystem(async (tx) => {
    // N-O12: open longer than the plant's SET-12 threshold (critical equipment uses the tighter one).
    const longOpen = await many<{ tenant_id: string; plant_id: string; plant_name: string; breakdown_id: string;
      criticality: string; days_open: number; long_open_days: number; critical_long_open_days: number; equipment_name: string }>(tx, `
      WITH s AS (
        SELECT tenant_id, plant_id,
               coalesce((maintenance_settings->>'longOpenAlertDays')::int, 3)     AS long_open_days,
               coalesce((maintenance_settings->>'criticalLongOpenDays')::int, 1) AS critical_long_open_days,
               coalesce((maintenance_settings->>'enabled')::boolean, false)      AS enabled,
               coalesce((maintenance_settings->>'criticalAlertEnabled')::boolean, true) AS critical_alert_enabled
          FROM app.plant_settings
      )
      SELECT b.tenant_id, b.plant_id, p.name AS plant_name, b.id AS breakdown_id, e.criticality,
             extract(day FROM (now() - b.started_at))::int AS days_open,
             s.long_open_days, s.critical_long_open_days, e.name AS equipment_name
        FROM app.breakdowns b
        JOIN app.equipment e ON e.tenant_id = b.tenant_id AND e.id = b.equipment_id
        JOIN app.plants   p ON p.tenant_id = b.tenant_id AND p.id = b.plant_id
        JOIN s ON s.tenant_id = b.tenant_id AND s.plant_id = b.plant_id
       WHERE b.status IN ('open', 'in_progress', 'awaiting_spares') AND s.enabled
         AND (e.criticality <> 'critical' OR s.critical_alert_enabled)`);
    for (const r of longOpen) {
      const threshold = r.criticality === 'critical' ? r.critical_long_open_days : r.long_open_days;
      if (r.days_open < threshold) continue;
      const link = `/plants/${r.plant_id}/maintenance/breakdowns/${r.breakdown_id}?ageing=${r.days_open}`;
      if (await alreadySent(tx, r.tenant_id, 'N-O12', link)) continue;
      outbox.push(...await notify(tx, {
        tenantId: r.tenant_id, to: await plantRecipients(tx, r.tenant_id, r.plant_id, ['client_admin', 'editor']),
        code: 'N-O12', title: `${r.plant_name}: ${r.equipment_name} breakdown open for ${r.days_open} day(s)`,
        body: `Open since ${r.days_open} day(s) ago.`, link,
      }));
    }

    // N-O13: expected restoration date has passed and the breakdown is still open.
    const overdue = await many<{ tenant_id: string; plant_id: string; plant_name: string; id: string; equipment_name: string; expected_restore_on: string }>(tx, `
      SELECT b.tenant_id, b.plant_id, p.name AS plant_name, b.id, e.name AS equipment_name, b.expected_restore_on
        FROM app.breakdowns b
        JOIN app.equipment e ON e.tenant_id = b.tenant_id AND e.id = b.equipment_id
        JOIN app.plants   p ON p.tenant_id = b.tenant_id AND p.id = b.plant_id
       WHERE b.status IN ('open', 'in_progress', 'awaiting_spares') AND b.expected_restore_on < $1::date`, [today]);
    for (const r of overdue) {
      const link = `/plants/${r.plant_id}/maintenance/breakdowns/${r.id}?overdue=1`;
      if (await alreadySent(tx, r.tenant_id, 'N-O13', link)) continue;
      outbox.push(...await notify(tx, {
        tenantId: r.tenant_id, to: await plantRecipients(tx, r.tenant_id, r.plant_id, ['client_admin', 'editor']),
        code: 'N-O13', title: `${r.plant_name}: ${r.equipment_name} restoration overdue`,
        body: `Expected restoration was ${formatDisplayDate(r.expected_restore_on)}.`, link,
      }));
    }

    // N-O15: SET-12 repeat breakdowns — the same equipment breaking down `repeatThreshold`+ times within `repeatWindowDays`.
    const repeats = await many<{ tenant_id: string; plant_id: string; plant_name: string; equipment_id: string;
      equipment_name: string; n: number; repeat_threshold: number; repeat_window_days: number }>(tx, `
      WITH s AS (
        SELECT tenant_id, plant_id,
               coalesce((maintenance_settings->>'repeatThreshold')::int, 3)    AS repeat_threshold,
               coalesce((maintenance_settings->>'repeatWindowDays')::int, 90) AS repeat_window_days,
               coalesce((maintenance_settings->>'enabled')::boolean, false)   AS enabled
          FROM app.plant_settings
      )
      SELECT b.tenant_id, b.plant_id, p.name AS plant_name, b.equipment_id, e.name AS equipment_name,
             count(*)::int AS n, s.repeat_threshold, s.repeat_window_days
        FROM app.breakdowns b
        JOIN app.equipment e ON e.tenant_id = b.tenant_id AND e.id = b.equipment_id
        JOIN app.plants   p ON p.tenant_id = b.tenant_id AND p.id = b.plant_id
        JOIN s ON s.tenant_id = b.tenant_id AND s.plant_id = b.plant_id
       WHERE b.status <> 'cancelled' AND s.enabled
         AND b.started_at >= now() - (s.repeat_window_days || ' days')::interval
       GROUP BY b.tenant_id, b.plant_id, p.name, b.equipment_id, e.name, s.repeat_threshold, s.repeat_window_days
      HAVING count(*) >= s.repeat_threshold`);
    for (const r of repeats) {
      const link = `/plants/${r.plant_id}/maintenance/equipment/${r.equipment_id}?repeat=${today}`;
      if (await alreadySent(tx, r.tenant_id, 'N-O15', link)) continue;
      outbox.push(...await notify(tx, {
        tenantId: r.tenant_id, to: await plantRecipients(tx, r.tenant_id, r.plant_id, ['client_admin']),
        code: 'N-O15', title: `${r.plant_name}: ${r.equipment_name} has broken down ${r.n} times in ${r.repeat_window_days} days`,
        body: `That is at or above the repeat-breakdown threshold of ${r.repeat_threshold}.`, link,
      }));
    }
  });
  sendInBackground(outbox);
});
