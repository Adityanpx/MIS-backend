import { many } from '../../db/sql';
import { withSystem } from '../../db/tenant';
import { registerHandler } from '../../jobs/boss';
import { QUEUES } from '../../jobs/queues';
import { addDays, diffDays, formatDisplayDate, todayIST } from '../../lib/dates';
import { logger } from '../../lib/logger';
import { D } from '../../lib/money';
import { invalidateClientAuthCache } from '../../middleware/auth-client';
import { formatMoney } from '../../shared/format';
import { CHEQUE_REVIEW_DAYS } from '../../config/constants';
import { systemActor } from '../audit/audit.service';
import { loadBillingConfig } from '../billing/billing-config';
import { notifyClientBilling, notifySuperAdmins } from '../billing/billing-notify';
import { sendInBackground } from '../notifications/email.service';
import { evaluate, invoiceOverdueDays } from './evaluate';
import { evaluateTenant, loadLifecycleInputs } from './lifecycle.service';

/** Subscription status transitions + pending plan changes (SUB-06/SUB-09), across all tenants. */
async function subscriptionTransitions(today: string): Promise<void> {
  await withSystem(async (tx) => {
    await tx.query(`UPDATE app.subscriptions SET status = 'ended' WHERE status = 'active' AND end_date < $1`, [today]);
    await tx.query(
      `UPDATE app.subscriptions s SET status = 'active'
        WHERE s.status = 'scheduled' AND s.start_date <= $1
          AND NOT EXISTS (SELECT 1 FROM app.subscriptions x WHERE x.tenant_id = s.tenant_id AND x.plant_id = s.plant_id AND x.status = 'active')`,
      [today],
    );
    await tx.query(
      `UPDATE app.subscriptions SET plan_id = pending_plan_id, plan_snapshot = pending_plan_snapshot,
              custom_price_per_year = NULL, custom_reason = NULL,
              pending_plan_id = NULL, pending_plan_snapshot = NULL, pending_effective = NULL
        WHERE pending_effective IS NOT NULL AND pending_effective <= $1`,
      [today],
    );
  });
}

registerHandler(QUEUES.lifecycleEvaluate, async () => {
  const today = todayIST();
  await subscriptionTransitions(today);
  const tenants = await withSystem((tx) => many<{ id: string }>(tx, `SELECT id FROM app.clients WHERE status = 'active' ORDER BY id`));
  const outbox: Array<string | null> = [];
  let changed = 0;
  for (const t of tenants) {
    try {
      const r = await withSystem((tx) => evaluateTenant(tx, t.id, { actor: systemActor(t.id), today }));
      changed += r.changes.length;
      outbox.push(...r.outbox);
    } catch (err) {
      logger.error({ err, tenantId: t.id }, 'Lifecycle evaluation failed for tenant');
      await withSystem((tx) => notifySuperAdmins(tx, {
        code: 'N-S06', title: 'Lifecycle evaluation failed', body: `Tenant ${t.id}: ${String((err as Error).message).slice(0, 200)}`,
        clientId: t.id, dedupeKey: `N-S06:lifecycle:${t.id}:${today}`, email: true,
      })).then(sendInBackground).catch(() => undefined);
    }
  }
  invalidateClientAuthCache();
  sendInBackground(outbox);
  logger.info({ tenants: tenants.length, changed }, 'Lifecycle evaluation done');
});

/**
 * Billing reminders (PRD §9.3, Appendix C): N-B02 pre-due, N-B03/N-B04/N-B05 overdue reminders, N-B10 renewal,
 * N-S02 cheques pending > 7 days, N-S05 digest of accounts changing state tomorrow. Every notice is idempotent.
 */
registerHandler(QUEUES.remindersBilling, async () => {
  const today = todayIST();
  const tomorrow = addDays(today, 1);
  const tenants = await withSystem((tx) => many<{ id: string; display_name: string }>(
    tx, `SELECT id, display_name FROM app.clients WHERE status = 'active' ORDER BY id`));
  const outbox: Array<string | null> = [];
  const digest: string[] = [];
  for (const t of tenants) {
    try {
      await withSystem(async (tx) => {
        const cfg = await loadBillingConfig(tx);
        const r = cfg.lifecycle;
        const { plants, invoices } = await loadLifecycleInputs(tx, t.id, today, r, cfg.tax.closeTolerance);
        const transitionDays = [r.graceDays + 1, r.graceDays + r.readOnlyDays + 1, r.graceDays + r.readOnlyDays + r.suspendedDays + 1];
        const seen = new Set<string>();
        for (const { plant, input } of plants) {
          if (plant.setup_status === 'closed' || plant.account_state === 'terminated') continue;
          for (const inv of input.invoices) {
            if (seen.has(inv.id) || !D(inv.balance).gt(input.tolerance)) continue;
            seen.add(inv.id);
            const row = invoices.find((i) => i.id === inv.id);
            const payLink = row?.rzp_link_url ?? undefined;
            const base = { invoiceNo: inv.number ?? '', amount: formatMoney(inv.balance), dueDate: formatDisplayDate(inv.dueDate), ...(payLink ? { payLink } : {}) };
            const toDue = diffDays(today, inv.dueDate);
            if (toDue > 0 && cfg.reminders.preDueDays.includes(toDue)) {
              outbox.push(...await notifyClientBilling(tx, {
                tenantId: t.id, code: 'N-B02', title: `Invoice ${inv.number} due in ${toDue} day(s)`, body: `Balance ${base.amount}.`,
                vars: { ...base, days: toDue }, dedupeKey: `N-B02:${inv.id}:${toDue}`,
              }));
            }
            const od = invoiceOverdueDays(inv, input.holds, today);
            if (od > 0 && cfg.reminders.overdueDays.includes(od) && !transitionDays.includes(od)) {
              const code = od <= r.graceDays ? 'N-B03' : od <= r.graceDays + r.readOnlyDays ? 'N-B04' : 'N-B05';
              const stageEnd = code === 'N-B03' ? r.graceDays : code === 'N-B04' ? r.graceDays + r.readOnlyDays : r.graceDays + r.readOnlyDays + r.suspendedDays;
              const nextDate = formatDisplayDate(addDays(today, stageEnd - od + 1));
              outbox.push(...await notifyClientBilling(tx, {
                tenantId: t.id, code, title: `Invoice ${inv.number} overdue (${od} days)`, body: `Balance ${base.amount}, due ${base.dueDate}.`,
                vars: { ...base, plantName: plant.name, payBy: formatDisplayDate(addDays(today, r.graceDays - od)), nextDate },
                dedupeKey: `${code}:${inv.id}:D${od}`,
              }));
            }
          }
          // N-S05 digest: state change tomorrow
          const ev = evaluate(input, tomorrow, r);
          if (ev.state !== plant.account_state && digest.length < 50) {
            digest.push(`${t.display_name} / ${plant.name}: ${plant.account_state} → ${ev.state}`);
          }
        }
        // N-B10 renewal reminders (SUB-08)
        const subs = await many<{ id: string; end_date: string; plan_name: string; plant_name: string }>(
          tx,
          `SELECT s.id, s.end_date, s.plan_snapshot->>'name' AS plan_name, p.name AS plant_name
             FROM app.subscriptions s JOIN app.plants p ON p.tenant_id = s.tenant_id AND p.id = s.plant_id
            WHERE s.tenant_id = $1 AND s.status = 'active' AND p.setup_status <> 'closed'
              AND NOT EXISTS (SELECT 1 FROM app.subscriptions n WHERE n.tenant_id = s.tenant_id AND n.plant_id = s.plant_id
                                AND n.status = 'scheduled')`,
          [t.id],
        );
        for (const s of subs) {
          const left = diffDays(today, s.end_date);
          if (!cfg.reminders.renewalDays.includes(left)) continue;
          outbox.push(...await notifyClientBilling(tx, {
            tenantId: t.id, code: 'N-B10', title: `${s.plant_name}: subscription ends in ${left} days`, body: 'Contact us to renew.',
            vars: { plantName: s.plant_name, planName: s.plan_name, endDate: formatDisplayDate(s.end_date), status: 'ending', statusText: 'ends' },
            dedupeKey: `N-B10:${s.id}:${left}`,
          }));
        }
        // N-S02 cheques pending clearance > 7 days
        const cheques = await many<{ id: string; reference: string | null; amount: string; payment_date: string }>(
          tx,
          `SELECT id, reference, amount, payment_date FROM app.payments
            WHERE tenant_id = $1 AND mode = 'cheque' AND status = 'pending_clearance' AND payment_date <= $2`,
          [t.id, addDays(today, -CHEQUE_REVIEW_DAYS)],
        );
        for (const c of cheques) {
          outbox.push(...await notifySuperAdmins(tx, {
            code: 'N-S02', title: `Cheque pending clearance > ${CHEQUE_REVIEW_DAYS} days`,
            body: `${t.display_name}: cheque ${c.reference ?? ''} for ${formatMoney(c.amount)} dated ${formatDisplayDate(c.payment_date)}.`,
            link: `/payments/${c.id}`, clientId: t.id, dedupeKey: `N-S02:${c.id}`,
          }));
        }
      });
    } catch (err) {
      logger.error({ err, tenantId: t.id }, 'Billing reminders failed for tenant');
    }
  }
  if (digest.length > 0) {
    outbox.push(...await withSystem((tx) => notifySuperAdmins(tx, {
      code: 'N-S05', title: `${digest.length} account(s) change state tomorrow`, body: digest.join('\n'),
      link: '/dashboard', dedupeKey: `N-S05:${today}`, email: true,
    })));
  }
  sendInBackground(outbox);
});
