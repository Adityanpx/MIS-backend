import { many, maybeOne } from '../../db/sql';
import { withSystem, type Tx } from '../../db/tenant';
import { registerHandler } from '../../jobs/boss';
import { QUEUES } from '../../jobs/queues';
import { addDays, diffDays, formatDisplayDate, todayIST } from '../../lib/dates';
import { dispatchEmails, sendInBackground } from './email.service';
import { notify, plantRecipients } from './notify.service';

/** Same notification (code + link) is never sent twice: makes cron retries harmless. */
async function alreadySent(tx: Tx, tenantId: string, code: string, link: string) {
  return !!(await maybeOne(tx, 'SELECT 1 FROM app.notifications WHERE tenant_id = $1 AND template_code = $2 AND link = $3 LIMIT 1',
    [tenantId, code, link]));
}

/** N-O01: yesterday's logsheet not submitted (run at 12:00 IST). */
registerHandler(QUEUES.logsheetMissing, async () => {
  const y = addDays(todayIST(), -1);
  const outbox: Array<string | null> = [];
  await withSystem(async (tx) => {
    const plants = await many<{ id: string; tenant_id: string; name: string }>(tx,
      `SELECT p.id, p.tenant_id, p.name FROM app.plants p JOIN app.clients c ON c.id = p.tenant_id
        WHERE p.setup_status = 'live' AND p.account_state IN ('active', 'grace') AND c.status = 'active'
          AND $1 BETWEEN p.mis_start AND p.om_end
          AND NOT EXISTS (SELECT 1 FROM app.logsheets l WHERE l.tenant_id = p.tenant_id AND l.plant_id = p.id
                            AND l.log_date = $1 AND l.status <> 'draft')`, [y]);
    for (const p of plants) {
      const link = `/plants/${p.id}/logsheets/${y}`;
      if (await alreadySent(tx, p.tenant_id, 'N-O01', link)) continue;
      outbox.push(...await notify(tx, { tenantId: p.tenant_id, to: await plantRecipients(tx, p.tenant_id, p.id, ['client_admin', 'editor']),
        code: 'N-O01', title: `${p.name}: logsheet for ${formatDisplayDate(y)} not submitted`, body: 'Please submit the daily logsheet.', link }));
    }
  });
  sendInBackground(outbox);
});

/** N-O04: BG / insurance expiring in 60 / 30 / 7 days or expired yesterday. N-O05: O&M contract ending in 180 / 90 / 30 days. */
registerHandler(QUEUES.remindersExpiry, async () => {
  const today = todayIST();
  const outbox: Array<string | null> = [];
  await withSystem(async (tx) => {
    const regs = await many<{ tenant_id: string; plant_id: string; plant_name: string; kind: string; label: string; number: string; end_date: string }>(tx,
      `SELECT b.tenant_id, b.plant_id, p.name AS plant_name, 'Bank guarantee' AS kind, b.label, b.bg_number AS number, b.end_date
         FROM app.bank_guarantees b JOIN app.plants p ON p.tenant_id = b.tenant_id AND p.id = b.plant_id
        WHERE b.end_date BETWEEN $1::date - 1 AND $1::date + 60
       UNION ALL
       SELECT i.tenant_id, i.plant_id, p.name, 'Insurance', i.policy_type, i.policy_number, i.end_date
         FROM app.insurance_policies i JOIN app.plants p ON p.tenant_id = i.tenant_id AND p.id = i.plant_id
        WHERE i.end_date BETWEEN $1::date - 1 AND $1::date + 60`, [today]);
    for (const r of regs) {
      const left = diffDays(today, r.end_date);
      if (![60, 30, 7, -1].includes(left)) continue;
      const link = `/plants/${r.plant_id}/settings/registers?ref=${encodeURIComponent(`${r.number}:${left}`)}`;
      if (await alreadySent(tx, r.tenant_id, 'N-O04', link)) continue;
      outbox.push(...await notify(tx, { tenantId: r.tenant_id, to: await plantRecipients(tx, r.tenant_id, r.plant_id, ['client_admin']),
        code: 'N-O04', email: true,
        title: left < 0 ? `${r.plant_name}: ${r.kind} ${r.label} has EXPIRED` : `${r.plant_name}: ${r.kind} ${r.label} expires in ${left} days`,
        body: `${r.kind} ${r.label} (${r.number}) ends on ${formatDisplayDate(r.end_date)}.`, link }));
    }
    const plants = await many<{ id: string; tenant_id: string; name: string; om_end: string }>(tx,
      `SELECT id, tenant_id, name, om_end FROM app.plants WHERE setup_status <> 'closed' AND om_end BETWEEN $1::date AND $1::date + 180`, [today]);
    for (const p of plants) {
      const left = diffDays(today, p.om_end);
      if (![180, 90, 30].includes(left)) continue;
      const link = `/plants/${p.id}/settings/general?ending=${left}`;
      if (await alreadySent(tx, p.tenant_id, 'N-O05', link)) continue;
      outbox.push(...await notify(tx, { tenantId: p.tenant_id, to: await plantRecipients(tx, p.tenant_id, p.id, ['client_admin']),
        code: 'N-O05', email: true, title: `${p.name}: O&M contract ends in ${left} days`,
        body: `The O&M contract ends on ${formatDisplayDate(p.om_end)}.`, link }));
    }
  });
  sendInBackground(outbox);
});

/** Emails still queued 2+ minutes after creation (process restarted, provider down) are retried. */
registerHandler(QUEUES.emailRetry, async () => {
  const ids = await withSystem((tx) => many<{ id: string }>(tx,
    `SELECT id FROM app.email_outbox WHERE status = 'queued' AND created_at < now() - interval '2 minutes' ORDER BY created_at LIMIT 200`));
  await dispatchEmails(ids.map((r) => r.id));
});
