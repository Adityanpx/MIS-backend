import { many, one } from '../../../db/sql';
import { withAdmin, type AdminTxCtx, type Tx } from '../../../db/tenant';
import { addDays, financialYear, todayIST } from '../../../lib/dates';
import { logger } from '../../../lib/logger';
import { loadBillingConfig } from '../../billing/billing-config';
import { evaluate } from '../../lifecycle/evaluate';
import { loadLifecycleInputs } from '../../lifecycle/lifecycle.service';

const fyRange = (fy: string) => ({ from: `${fy.slice(0, 4)}-04-01`, to: `${Number(fy.slice(0, 4)) + 1}-03-31` });

/** Plants whose state changes in the next `days` days (projection with the pure evaluator). Cached 5 minutes. */
let projectionCache: { at: number; days: number; rows: Projected[] } | null = null;
export interface Projected { clientId: string; clientName: string; plantId: string; plantName: string; from: string; to: string; on: string }
export async function projectedChanges(tx: Tx, days: number): Promise<Projected[]> {
  if (projectionCache && projectionCache.days === days && Date.now() - projectionCache.at < 300_000) return projectionCache.rows;
  const today = todayIST();
  const cfg = await loadBillingConfig(tx);
  const tenants = await many<{ id: string; display_name: string }>(tx, `SELECT id, display_name FROM app.clients WHERE status = 'active'`);
  const out: Projected[] = [];
  for (const t of tenants) {
    const { plants } = await loadLifecycleInputs(tx, t.id, today, cfg.lifecycle, cfg.tax.closeTolerance);
    for (const { plant, input } of plants) {
      if (plant.setup_status === 'closed') continue;
      const ev = evaluate(input, today, cfg.lifecycle);
      if (ev.nextChange && ev.nextChange.on <= addDays(today, days)) {
        out.push({ clientId: t.id, clientName: t.display_name, plantId: plant.id, plantName: plant.name, from: ev.state, to: ev.nextChange.state, on: ev.nextChange.on });
      }
    }
  }
  out.sort((a, b) => a.on.localeCompare(b.on));
  projectionCache = { at: Date.now(), days, rows: out };
  return out;
}

async function failedJobs(tx: Tx): Promise<number | null> {
  try {
    const r = await one<{ n: number }>(tx, `SELECT count(*) AS n FROM pgboss.job WHERE state = 'failed' AND completed_on > now() - interval '7 days'`);
    return r.n;
  } catch (err) {
    logger.debug({ err }, 'pg-boss job table not available');
    return null;
  }
}

export async function actionList(ctx: AdminTxCtx) {
  return withAdmin(ctx, async (tx) => ({
    chequesPending: await many(tx,
      `SELECT p.id, p.tenant_id AS "clientId", c.display_name AS "clientName", p.amount, p.reference, p.bank, p.payment_date AS "paymentDate"
         FROM app.payments p JOIN app.clients c ON c.id = p.tenant_id
        WHERE p.mode = 'cheque' AND p.status = 'pending_clearance' ORDER BY p.payment_date`),
    paymentsNeedingReview: await many(tx,
      `SELECT p.id, p.tenant_id AS "clientId", c.display_name AS "clientName", p.amount, p.reference, p.review_note AS "reviewNote", p.payment_date AS "paymentDate"
         FROM app.payments p JOIN app.clients c ON c.id = p.tenant_id WHERE p.needs_review ORDER BY p.created_at DESC LIMIT 100`),
    paymentNotifications: await many(tx,
      `SELECT n.id, n.tenant_id AS "clientId", c.display_name AS "clientName", n.amount, n.reference, n.paid_on AS "paidOn"
         FROM app.payment_notifications n JOIN app.clients c ON c.id = n.tenant_id WHERE n.status = 'pending' ORDER BY n.created_at`),
    stateChangesNext7Days: await projectedChanges(tx, 7),
    plantRequests: await many(tx,
      `SELECT r.id, r.tenant_id AS "clientId", c.display_name AS "clientName", r.details, r.created_at AS "createdAt"
         FROM app.plant_requests r JOIN app.clients c ON c.id = r.tenant_id WHERE r.status = 'pending' ORDER BY r.created_at`),
    failedEmails: await many(tx,
      `SELECT id, tenant_id AS "clientId", template_code AS "templateCode", to_emails AS "to", error, created_at AS "createdAt"
         FROM app.email_outbox WHERE status IN ('failed', 'bounced') AND created_at > now() - interval '30 days'
        ORDER BY created_at DESC LIMIT 100`),
    webhookErrors: await many(tx,
      `SELECT event_id AS "eventId", event_type AS "eventType", error, received_at AS "receivedAt" FROM app.razorpay_events
        WHERE error IS NOT NULL AND received_at > now() - interval '30 days' ORDER BY received_at DESC LIMIT 50`),
    failedJobs7d: await failedJobs(tx),
  }));
}

export async function dashboard(ctx: AdminTxCtx, fyParam?: string) {
  const today = todayIST();
  const fy = fyParam ?? financialYear(today);
  const range = fyRange(fy);
  return withAdmin(ctx, async (tx) => {
    const clientsByState = await many<{ state: string; n: number }>(tx,
      `SELECT account_state AS state, count(*) AS n FROM app.clients WHERE status <> 'deleted' GROUP BY account_state`);
    const plantsByTerm = await many<{ term: number | null; n: number }>(tx,
      `SELECT (SELECT (s.plan_snapshot->>'termYears')::int FROM app.subscriptions s WHERE s.tenant_id = p.tenant_id AND s.plant_id = p.id
                AND s.status IN ('active', 'scheduled') ORDER BY (s.status = 'active') DESC LIMIT 1) AS term, count(*) AS n
         FROM app.plants p JOIN app.clients c ON c.id = p.tenant_id WHERE c.status <> 'deleted' GROUP BY 1`);
    const plantsByType = await many<{ type: string; n: number }>(tx,
      `SELECT p.type, count(*) AS n FROM app.plants p JOIN app.clients c ON c.id = p.tenant_id WHERE c.status <> 'deleted' GROUP BY p.type`);
    const money = await one<Record<string, string>>(tx,
      `SELECT
         coalesce((SELECT sum(total) FROM app.invoices WHERE status <> 'draft' AND issue_date BETWEEN $1 AND $2), 0)
           - coalesce((SELECT sum(total) FROM app.credit_notes WHERE cn_date BETWEEN $1 AND $2), 0) AS billed,
         coalesce((SELECT sum(amount) FROM app.payments WHERE status = 'applied' AND payment_date BETWEEN $1 AND $2), 0) AS collected,
         coalesce((SELECT sum(balance) FROM app.invoices WHERE status IN ('issued', 'partially_paid', 'overdue')), 0) AS outstanding,
         coalesce((SELECT sum(balance) FROM app.invoices WHERE status IN ('issued', 'partially_paid', 'overdue') AND due_date < $3), 0) AS overdue,
         coalesce((SELECT sum(amount) FROM app.tds_entries WHERE certificate_status = 'pending'), 0) AS tds_receivable,
         coalesce((SELECT sum(total) FROM app.credit_notes WHERE cn_date BETWEEN $1 AND $2), 0) AS credit_notes`,
      [range.from, range.to, today]);
    const window = async (sql: string) => {
      const out: Record<string, unknown> = {};
      for (const d of [30, 60, 90]) out[`d${d}`] = await one(tx, sql, [today, addDays(today, d)]);
      return out;
    };
    const dueSoon = await window(
      `SELECT count(*) AS count, coalesce(sum(balance), 0) AS amount FROM app.invoices
        WHERE status IN ('issued', 'partially_paid') AND due_date BETWEEN $1 AND $2`);
    const endingSoon = await window(
      `SELECT (SELECT count(*) FROM app.subscriptions WHERE status = 'active' AND end_date BETWEEN $1 AND $2) AS subscriptions,
              (SELECT count(*) FROM app.plants WHERE setup_status <> 'closed' AND om_end BETWEEN $1 AND $2) AS "omContracts",
              (SELECT count(*) FROM app.bank_guarantees WHERE end_date BETWEEN $1 AND $2)
                + (SELECT count(*) FROM app.insurance_policies WHERE end_date BETWEEN $1 AND $2) AS "registerDocuments"`);
    const collectionsTrend = await many(tx,
      `SELECT to_char(m, 'YYYY-MM') AS month,
              coalesce((SELECT sum(amount) FROM app.payments p WHERE p.status = 'applied' AND date_trunc('month', p.payment_date) = m), 0) AS amount
         FROM generate_series(date_trunc('month', $1::date) - interval '11 months', date_trunc('month', $1::date), interval '1 month') AS m
        ORDER BY m`, [today]);
    const recentActivity = await many(tx,
      `SELECT a.id, a.at, a.actor_type AS "actorType", a.action, a.entity, a.entity_id AS "entityId", c.display_name AS "clientName"
         FROM app.audit_log a LEFT JOIN app.clients c ON c.id = a.tenant_id ORDER BY a.at DESC LIMIT 10`);
    const usage = await one(tx,
      `SELECT (SELECT count(*) FROM app.logsheets WHERE status <> 'draft' AND log_date = $1::date - 1) AS "submittedYesterday",
              (SELECT count(*) FROM app.plants p JOIN app.clients c ON c.id = p.tenant_id
                WHERE p.setup_status = 'live' AND p.account_state IN ('active', 'grace') AND c.status = 'active') AS "livePlants",
              (SELECT count(*) FROM app.plants p JOIN app.clients c ON c.id = p.tenant_id
                WHERE p.setup_status = 'live' AND c.status = 'active' AND p.account_state IN ('active', 'grace')
                  AND coalesce((SELECT max(l.log_date) FROM app.logsheets l WHERE l.tenant_id = p.tenant_id AND l.plant_id = p.id
                                  AND l.status <> 'draft'), '1900-01-01') < $1::date - 3) AS "noSubmission3d"`, [today]);
    const actions = await one(tx,
      `SELECT (SELECT count(*) FROM app.payments WHERE mode = 'cheque' AND status = 'pending_clearance') AS "chequesPending",
              (SELECT count(*) FROM app.payments WHERE needs_review) AS "paymentsNeedingReview",
              (SELECT count(*) FROM app.payment_notifications WHERE status = 'pending') AS "paymentNotifications",
              (SELECT count(*) FROM app.plant_requests WHERE status = 'pending') AS "plantRequests",
              (SELECT count(*) FROM app.email_outbox WHERE status IN ('failed', 'bounced') AND created_at > now() - interval '30 days') AS "failedEmails"`);
    return {
      fy,
      clients: { total: clientsByState.reduce((s, r) => s + r.n, 0), byState: Object.fromEntries(clientsByState.map((r) => [r.state, r.n])) },
      plants: {
        total: plantsByType.reduce((s, r) => s + r.n, 0),
        byTerm: Object.fromEntries(plantsByTerm.map((r) => [r.term === null ? 'none' : String(r.term), r.n])),
        byType: Object.fromEntries(plantsByType.map((r) => [r.type, r.n])),
      },
      money: {
        billed: money.billed, collected: money.collected, outstanding: money.outstanding, overdue: money.overdue,
        tdsReceivable: money.tds_receivable, creditNotes: money.credit_notes,
      },
      dueSoon, endingSoon, collectionsTrend, recentActivity, usage,
      actions: { ...actions, stateChangesNext7Days: (await projectedChanges(tx, 7)).length, failedJobs7d: await failedJobs(tx) },
    };
  });
}
