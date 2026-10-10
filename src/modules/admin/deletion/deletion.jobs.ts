import { exec, many, maybeOne } from '../../../db/sql';
import { withSystem } from '../../../db/tenant';
import { registerHandler } from '../../../jobs/boss';
import { QUEUES } from '../../../jobs/queues';
import { addDays, formatDisplayDate, todayIST } from '../../../lib/dates';
import { logger } from '../../../lib/logger';
import { invalidateClientAuthCache } from '../../../middleware/auth-client';
import { systemActor, writeAudit } from '../../audit/audit.service';
import { loadBillingConfig } from '../../billing/billing-config';
import { notifyClientBilling, notifySuperAdmins } from '../../billing/billing-notify';
import { BILLING_PREFIX, storage } from '../../files/storage';
import { sendInBackground } from '../../notifications/email.service';
import { OPERATIONAL_TABLES } from './deletion.service';

/** Idempotent: a retry after a crash finishes whatever is left (DB part is one transaction; files after commit). */
registerHandler(QUEUES.clientDelete, async (data) => {
  const { tenantId, adminId } = data as { tenantId: string; adminId: string | null };
  const proceed = await withSystem(async (tx) => {
    const c = await maybeOne<{ status: string }>(tx, 'SELECT status FROM app.clients WHERE id = $1 FOR UPDATE', [tenantId]);
    if (!c) return false;
    if (c.status === 'deleted') return true; // DB part done by an earlier attempt: continue with the files
    if (c.status !== 'scheduled_for_deletion') throw new Error(`Client ${tenantId} is not scheduled for deletion`);
    const counts: Record<string, number> = {};
    for (const t of OPERATIONAL_TABLES) counts[t] = await exec(tx, `DELETE FROM app.${t} WHERE tenant_id = $1`, [tenantId]);
    await exec(
      tx,
      `UPDATE app.clients SET status = 'deleted', deleted_at = now(), primary_contact = '{}'::jsonb, billing_emails = '{}',
              logo_key = NULL, notes = NULL WHERE id = $1`,
      [tenantId],
    );
    await writeAudit(tx, { tenantId, actorType: adminId ? 'super_admin' : 'system', actorId: adminId }, {
      action: 'client.delete', entity: 'client', entityId: tenantId, after: { deletedRows: counts },
    });
    return true;
  });
  if (!proceed) return;
  const keys = (await storage.listKeys(`t/${tenantId}/`)).filter((k) => !k.startsWith(`t/${tenantId}/${BILLING_PREFIX}/`));
  await storage.removeMany(keys);
  invalidateClientAuthCache();
  const outbox = await withSystem((tx) => notifySuperAdmins(tx, {
    code: 'CLIENT_DELETED', title: 'Client data deleted', body: `${keys.length} file(s) removed. Financial records were kept.`,
    clientId: tenantId, dedupeKey: `CLIENT_DELETED:${tenantId}`,
  }));
  sendInBackground(outbox);
  logger.info({ tenantId, files: keys.length }, 'Client data deleted');
});

/** 05:00 IST: N-B12 seven days before; then terminated + retention → "scheduled for deletion" (nothing is deleted without confirmation). */
registerHandler(QUEUES.deletionQueue, async () => {
  const today = todayIST();
  const outbox: Array<string | null> = [];
  await withSystem(async (tx) => {
    const cfg = await loadBillingConfig(tx);
    const rows = await many<{ id: string; display_name: string; terminated_on: string }>(
      tx,
      `SELECT id, display_name, (terminated_at AT TIME ZONE 'Asia/Kolkata')::date AS terminated_on
         FROM app.clients WHERE status = 'active' AND account_state = 'terminated' AND terminated_at IS NOT NULL`,
    );
    for (const c of rows) {
      const deleteOn = addDays(c.terminated_on, cfg.lifecycle.retentionDays);
      if (addDays(deleteOn, -7) <= today && today < deleteOn) {
        outbox.push(...await notifyClientBilling(tx, {
          tenantId: c.id, code: 'N-B12', title: `Data will be deleted on ${formatDisplayDate(deleteOn)}`, body: 'Download your data export before then.',
          vars: { deleteOn: formatDisplayDate(deleteOn), terminatedOn: formatDisplayDate(c.terminated_on) }, dedupeKey: `N-B12:${c.id}`,
        }));
      }
      if (deleteOn <= today) {
        await exec(tx, `UPDATE app.clients SET status = 'scheduled_for_deletion' WHERE id = $1 AND status = 'active'`, [c.id]);
        await writeAudit(tx, systemActor(c.id), { action: 'client.scheduled_for_deletion', entity: 'client', entityId: c.id });
        outbox.push(...await notifySuperAdmins(tx, {
          code: 'DELETION_DUE', title: `${c.display_name}: scheduled for deletion`, body: 'Confirm the deletion by typing the client code.',
          link: `/clients/${c.id}`, clientId: c.id, dedupeKey: `DELETION_DUE:${c.id}`, email: true,
        }));
      }
    }
  });
  sendInBackground(outbox);
});
