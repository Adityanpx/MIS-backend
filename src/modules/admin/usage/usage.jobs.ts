import { many } from '../../../db/sql';
import { withSystem } from '../../../db/tenant';
import { registerHandler } from '../../../jobs/boss';
import { QUEUES } from '../../../jobs/queues';
import { todayIST } from '../../../lib/dates';
import { DEFAULT_MAX_USERS_PER_PLANT, DEFAULT_STORAGE_GB_PER_PLANT } from '../../../shared/constants';
import { notifySuperAdmins } from '../../billing/billing-notify';
import { sendInBackground } from '../../notifications/email.service';
import { notify, plantRecipients } from '../../notifications/notify.service';

const CURRENT_SUB = (col: string) => `(SELECT ${col} FROM app.subscriptions s WHERE s.tenant_id = p.tenant_id AND s.plant_id = p.id
   AND s.status IN ('active', 'scheduled') ORDER BY (s.status = 'active') DESC, s.start_date LIMIT 1)`;

registerHandler(QUEUES.usageSnapshot, async () => {
  const today = todayIST();
  const month = today.slice(0, 7);
  const outbox: Array<string | null> = [];
  await withSystem(async (tx) => {
    await tx.query(
      `INSERT INTO app.usage_snapshots (snap_date, tenant_id, plant_id, active_users, max_users, storage_bytes, storage_gb,
                                        logsheets_7d, logsheets_30d, last_logsheet_date, last_login_at, setup_status, account_state)
       SELECT $1::date, p.tenant_id, p.id,
              (SELECT count(*) FROM app.user_plant_roles r JOIN app.users u ON u.tenant_id = r.tenant_id AND u.id = r.user_id
                WHERE r.tenant_id = p.tenant_id AND r.plant_id = p.id AND u.status IN ('active', 'invited') AND NOT u.is_client_admin),
              coalesce(${CURRENT_SUB("(s.plan_snapshot->>'maxUsersPerPlant')::int")}, $2),
              coalesce((SELECT sum(d.size_bytes) FROM app.pdf_documents d WHERE d.tenant_id = p.tenant_id AND d.plant_id = p.id AND d.file_key IS NOT NULL), 0),
              coalesce(${CURRENT_SUB("(s.plan_snapshot->>'storageGb')::int")}, $3),
              (SELECT count(*) FROM app.logsheets l WHERE l.tenant_id = p.tenant_id AND l.plant_id = p.id AND l.status <> 'draft' AND l.log_date > $1::date - 7),
              (SELECT count(*) FROM app.logsheets l WHERE l.tenant_id = p.tenant_id AND l.plant_id = p.id AND l.status <> 'draft' AND l.log_date > $1::date - 30),
              (SELECT max(l.log_date) FROM app.logsheets l WHERE l.tenant_id = p.tenant_id AND l.plant_id = p.id AND l.status <> 'draft'),
              (SELECT max(u.last_login_at) FROM app.users u WHERE u.tenant_id = p.tenant_id),
              p.setup_status, p.account_state
         FROM app.plants p JOIN app.clients c ON c.id = p.tenant_id
        WHERE c.status = 'active'
       ON CONFLICT (snap_date, tenant_id, plant_id) DO UPDATE SET
         active_users = EXCLUDED.active_users, max_users = EXCLUDED.max_users, storage_bytes = EXCLUDED.storage_bytes,
         storage_gb = EXCLUDED.storage_gb, logsheets_7d = EXCLUDED.logsheets_7d, logsheets_30d = EXCLUDED.logsheets_30d,
         last_logsheet_date = EXCLUDED.last_logsheet_date, last_login_at = EXCLUDED.last_login_at,
         setup_status = EXCLUDED.setup_status, account_state = EXCLUDED.account_state`,
      [today, DEFAULT_MAX_USERS_PER_PLANT, DEFAULT_STORAGE_GB_PER_PLANT],
    );
    await tx.query('DELETE FROM app.usage_snapshots WHERE snap_date < $1::date - 400', [today]);
    // PDF-10: soft storage limit → warning to the Client Admin and the Super Admin (once per month per plant).
    const over = await many<{ tenant_id: string; plant_id: string; plant_name: string; client_name: string; gb: string; limit_gb: number }>(
      tx,
      `SELECT u.tenant_id, u.plant_id, p.name AS plant_name, c.display_name AS client_name,
              round(u.storage_bytes / 1073741824.0, 2)::text AS gb, u.storage_gb AS limit_gb
         FROM app.usage_snapshots u JOIN app.plants p ON p.tenant_id = u.tenant_id AND p.id = u.plant_id
         JOIN app.clients c ON c.id = u.tenant_id
        WHERE u.snap_date = $1 AND u.storage_bytes > u.storage_gb::bigint * 1073741824`,
      [today],
    );
    for (const o of over) {
      const key = `USAGE_STORAGE:${o.plant_id}:${month}`;
      const claimed = await tx.query('INSERT INTO app.reminder_log (tenant_id, key) VALUES ($1, $2) ON CONFLICT DO NOTHING', [o.tenant_id, key]);
      if ((claimed.rowCount ?? 0) === 0) continue;
      outbox.push(...await notify(tx, {
        tenantId: o.tenant_id, to: await plantRecipients(tx, o.tenant_id, o.plant_id, ['client_admin']), code: 'USAGE_STORAGE',
        title: `${o.plant_name}: PDF storage ${o.gb} GB of ${o.limit_gb} GB`, body: 'The plan storage limit is exceeded. PDFs are still generated; contact your provider to upgrade.',
        link: `/plants/${o.plant_id}/pdfs`, critical: true,
      }));
      outbox.push(...await notifySuperAdmins(tx, {
        code: 'USAGE_STORAGE', title: `${o.client_name} / ${o.plant_name}: storage ${o.gb} GB of ${o.limit_gb} GB`, body: 'Soft limit exceeded (PDF-10).',
        link: '/usage', clientId: o.tenant_id, dedupeKey: key,
      }));
    }
  });
  sendInBackground(outbox);
});
