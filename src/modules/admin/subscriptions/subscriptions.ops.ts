import { exec, many, maybeOne, one } from '../../../db/sql';
import { withAdmin, type AdminTxCtx, type Tx } from '../../../db/tenant';
import type { PlanSnapshot } from '../../../db/types';
import { enqueue } from '../../../jobs/boss';
import { QUEUES } from '../../../jobs/queues';
import { addDays, addMonths, maxDate, minDate, todayIST, type ISODate } from '../../../lib/dates';
import { conflict, notFound, unprocessable } from '../../../lib/errors';
import type { RequestMeta } from '../../../lib/request-meta';
import { invalidateClientAuthCache } from '../../../middleware/auth-client';
import { MAX_CONTRACT_YEARS } from '../../../shared/constants';
import type { BillingMode } from '../../../shared/enums';
import { adminActor, writeAudit } from '../../audit/audit.service';
import { loadBillingConfig, type BillingConfig } from '../../billing/billing-config';
import { cancelInvoiceTx } from '../../billing/invoices.service';
import { buildBillingSchedule, escalatedYearAmounts, subscriptionEndDate } from '../../domain/pricing';
import { evaluateTenant } from '../../lifecycle/lifecycle.service';
import { sendInBackground } from '../../notifications/email.service';
import { loadPlan, type PlanRowFull } from '../plans/plans.service';
import { getSubscription } from './subscriptions.service';

const snapshotOf = (plan: PlanRowFull): PlanSnapshot => ({
  planId: plan.id, name: plan.name, code: plan.code, termYears: plan.term_years, pricePerYear: plan.price_per_year,
  escalationPct: plan.escalation_pct, upfrontDiscountPct: plan.upfront_discount_pct, maxUsersPerPlant: plan.max_users_per_plant,
  storageGb: plan.storage_gb, features: plan.features,
});

/** INV-02 dates for a billing period that starts on `from`. */
function scheduleDates(from: ISODate, today: ISODate, cfg: BillingConfig) {
  const planned = maxDate(today, addDays(from, -cfg.billing.invoiceLeadDays));
  const earliestDue = addDays(planned, cfg.billing.minPaymentTermsDays);
  return { planned, due: from < earliestDue ? earliestDue : from };
}

async function lockSubscription(tx: Tx, id: string) {
  const s = await maybeOne<{
    id: string; tenant_id: string; plant_id: string; status: string; start_date: string; end_date: string; billing_mode: string;
    plan_snapshot: PlanSnapshot; custom_price_per_year: string | null; om_end: string;
  }>(
    tx,
    `SELECT s.id, s.tenant_id, s.plant_id, s.status, s.start_date, s.end_date, s.billing_mode, s.plan_snapshot, s.custom_price_per_year,
            p.om_end
       FROM app.subscriptions s JOIN app.plants p ON p.tenant_id = s.tenant_id AND p.id = s.plant_id
       JOIN app.clients c ON c.id = s.tenant_id
      WHERE s.id = $1 AND c.status <> 'deleted' FOR UPDATE OF s`,
    [id],
  );
  if (!s) throw notFound('Subscription');
  return s;
}

async function finish(tenantId: string, outbox: Array<string | null>, subscriptionId?: string) {
  invalidateClientAuthCache();
  sendInBackground(outbox);
  if (subscriptionId) await enqueue(QUEUES.invoicesGenerate, { subscriptionId });
}

export interface RenewInput {
  plantId: string; planId: string; startDate?: string; billingMode: BillingMode; customPricePerYear?: string; customReason?: string;
}
/** SUB-01/04/08: renewal = a new subscription that starts the day after the current one ends (or later). */
export async function renewSubscription(ctx: AdminTxCtx, input: RenewInput, meta: RequestMeta) {
  const today = todayIST();
  const r = await withAdmin(ctx, async (tx) => {
    const plant = await maybeOne<{ tenant_id: string; setup_status: string; om_end: string }>(
      tx,
      `SELECT p.tenant_id, p.setup_status, p.om_end FROM app.plants p JOIN app.clients c ON c.id = p.tenant_id
        WHERE p.id = $1 AND c.status = 'active' FOR UPDATE OF p`,
      [input.plantId],
    );
    if (!plant) throw notFound('Plant');
    if (plant.setup_status === 'closed') throw conflict('PLANT_CLOSED', 'This plant is closed.');
    const tenantId = plant.tenant_id;
    await exec(tx, `UPDATE app.subscriptions SET status = 'ended' WHERE tenant_id = $1 AND plant_id = $2 AND status = 'active' AND end_date < $3`,
      [tenantId, input.plantId, today]);
    const scheduled = await maybeOne(tx, `SELECT 1 FROM app.subscriptions WHERE tenant_id = $1 AND plant_id = $2 AND status = 'scheduled'`,
      [tenantId, input.plantId]);
    if (scheduled) throw conflict('RENEWAL_EXISTS', 'A renewal is already scheduled for this plant.');
    const last = await one<{ end_date: string | null; active: boolean }>(
      tx,
      `SELECT max(end_date) AS end_date, bool_or(status = 'active') AS active FROM app.subscriptions
        WHERE tenant_id = $1 AND plant_id = $2 AND status IN ('active', 'ended', 'cancelled')`,
      [tenantId, input.plantId],
    );
    const earliest = last.end_date ? addDays(last.end_date, 1) : today;
    const start = input.startDate ?? (last.active ? earliest : maxDate(earliest, today));
    if (start < earliest) throw unprocessable('RENEWAL_OVERLAPS', `The renewal must start on or after ${earliest}.`);
    const plan = await loadPlan(tx, input.planId);
    if (plan.status !== 'active') throw unprocessable('PLAN_ARCHIVED', 'This plan is archived and cannot be used for new subscriptions.');
    const endDate = subscriptionEndDate(start, plan.term_years);
    if (endDate < today) throw unprocessable('SUBSCRIPTION_ALREADY_ENDED', 'The subscription period has already ended.');
    const cfg = await loadBillingConfig(tx);
    const schedule = buildBillingSchedule({
      startDate: start, termYears: plan.term_years, billingMode: input.billingMode,
      pricePerYear: input.customPricePerYear ?? plan.price_per_year, escalationPct: plan.escalation_pct,
      upfrontDiscountPct: plan.upfront_discount_pct, today, invoiceLeadDays: cfg.billing.invoiceLeadDays,
      minPaymentTermsDays: cfg.billing.minPaymentTermsDays,
    });
    const status = start > today ? 'scheduled' : 'active';
    const { id } = await one<{ id: string }>(
      tx,
      `INSERT INTO app.subscriptions (tenant_id, plant_id, plan_id, plan_snapshot, custom_price_per_year, custom_reason,
                                      start_date, end_date, billing_mode, status, created_by)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [tenantId, input.plantId, plan.id, JSON.stringify(snapshotOf(plan)), input.customPricePerYear ?? null, input.customReason ?? null,
        start, endDate, input.billingMode, status, ctx.adminId],
    );
    for (const s of schedule) {
      await exec(
        tx,
        `INSERT INTO app.billing_schedule (tenant_id, subscription_id, year_no, period_from, period_to, amount, planned_invoice_date, due_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [tenantId, id, s.yearNo, s.periodFrom, s.periodTo, s.amount, s.plannedInvoiceDate, s.dueDate],
      );
    }
    const actor = adminActor(ctx.adminId, tenantId);
    await writeAudit(tx, actor, {
      action: 'subscription.renew', entity: 'subscription', entityId: id,
      after: { plan: plan.code, start, endDate, billingMode: input.billingMode, customPricePerYear: input.customPricePerYear ?? null },
      reason: input.customReason ?? null,
    }, meta);
    const ev = await evaluateTenant(tx, tenantId, { actor, cause: 'manual', note: 'Subscription renewed' });
    return { id, tenantId, outbox: ev.outbox, warnings: endDate > plant.om_end ? ['SUBSCRIPTION_ENDS_AFTER_OM_END'] : [] };
  });
  await finish(r.tenantId, r.outbox, r.id);
  return { ...(await getSubscription(ctx, r.id)), warnings: r.warnings };
}

/** SUB-05: add years (total ≤ 15) at the locked price (continued escalation) or at a new price. Extension years are billed yearly. */
export async function extendSubscription(ctx: AdminTxCtx, id: string, input: { addYears: number; pricePerYear?: string; reason: string }, meta: RequestMeta) {
  const today = todayIST();
  const r = await withAdmin(ctx, async (tx) => {
    const s = await lockSubscription(tx, id);
    if (!['active', 'scheduled'].includes(s.status)) throw conflict('SUBSCRIPTION_NOT_ACTIVE', 'Only an active or scheduled subscription can be extended.');
    const oldTerm = s.plan_snapshot.termYears;
    const newTerm = oldTerm + input.addYears;
    if (newTerm > MAX_CONTRACT_YEARS) throw unprocessable('CONTRACT_TOO_LONG', `Maximum contract length is ${MAX_CONTRACT_YEARS} years (currently ${oldTerm}).`);
    const newEnd = subscriptionEndDate(s.start_date, newTerm);
    const cfg = await loadBillingConfig(tx);
    const amounts = input.pricePerYear
      ? escalatedYearAmounts(input.pricePerYear, s.plan_snapshot.escalationPct, input.addYears).map((a) => a.amount)
      : escalatedYearAmounts(s.custom_price_per_year ?? s.plan_snapshot.pricePerYear, s.plan_snapshot.escalationPct, newTerm)
          .slice(oldTerm).map((a) => a.amount);
    for (let j = 0; j < input.addYears; j++) {
      const k = oldTerm + j + 1; // contract-year number of the subscription
      const from = addMonths(s.start_date, 12 * (k - 1));
      const to = minDate(addDays(addMonths(s.start_date, 12 * k), -1), newEnd);
      const d = scheduleDates(from, today, cfg);
      await exec(
        tx,
        `INSERT INTO app.billing_schedule (tenant_id, subscription_id, year_no, period_from, period_to, amount, planned_invoice_date, due_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [s.tenant_id, id, k, from, to, amounts[j], d.planned, d.due],
      );
    }
    await exec(
      tx,
      `UPDATE app.subscriptions SET end_date = $3, plan_snapshot = jsonb_set(plan_snapshot, '{termYears}', to_jsonb($4::int))
        WHERE tenant_id = $1 AND id = $2`,
      [s.tenant_id, id, newEnd, newTerm],
    );
    const actor = adminActor(ctx.adminId, s.tenant_id);
    await writeAudit(tx, actor, {
      action: 'subscription.extend', entity: 'subscription', entityId: id,
      before: { termYears: oldTerm, endDate: s.end_date }, after: { termYears: newTerm, endDate: newEnd, pricePerYear: input.pricePerYear ?? 'locked', amounts },
      reason: input.reason,
    }, meta);
    const ev = await evaluateTenant(tx, s.tenant_id, { actor, cause: 'manual', note: 'Subscription extended' });
    return { tenantId: s.tenant_id, outbox: ev.outbox, warnings: newEnd > s.om_end ? ['SUBSCRIPTION_ENDS_AFTER_OM_END'] : [] };
  });
  await finish(r.tenantId, r.outbox, id);
  return { ...(await getSubscription(ctx, id)), warnings: r.warnings };
}

/** SUB-06 (P1): the new plan applies from the next billing year that has not been invoiced. */
export async function changePlan(ctx: AdminTxCtx, id: string, input: { planId: string; reason: string }, meta: RequestMeta) {
  const today = todayIST();
  const r = await withAdmin(ctx, async (tx) => {
    const s = await lockSubscription(tx, id);
    if (s.status !== 'active') throw conflict('SUBSCRIPTION_NOT_ACTIVE', 'Only an active subscription can change plan.');
    if (s.billing_mode === 'upfront') throw conflict('NOT_APPLICABLE_UPFRONT', 'An upfront subscription is fully billed; renew or extend instead.');
    const plan = await loadPlan(tx, input.planId);
    if (plan.status !== 'active') throw unprocessable('PLAN_ARCHIVED', 'This plan is archived.');
    const next = await maybeOne<{ year_no: number; period_from: string }>(
      tx,
      `SELECT year_no, period_from FROM app.billing_schedule
        WHERE tenant_id = $1 AND subscription_id = $2 AND invoice_id IS NULL AND period_from > $3
        ORDER BY year_no LIMIT 1`,
      [s.tenant_id, id, today],
    );
    if (!next) throw conflict('NO_FUTURE_BILLING_YEAR', 'There is no future billing year left to change.');
    const amounts = escalatedYearAmounts(plan.price_per_year, plan.escalation_pct, s.plan_snapshot.termYears);
    const rows = await many<{ id: string; year_no: number }>(
      tx, 'SELECT id, year_no FROM app.billing_schedule WHERE tenant_id = $1 AND subscription_id = $2 AND invoice_id IS NULL AND year_no >= $3',
      [s.tenant_id, id, next.year_no]);
    for (const row of rows) {
      const amount = amounts[row.year_no - 1]?.amount;
      if (!amount) continue;
      await exec(tx, 'UPDATE app.billing_schedule SET amount = $3 WHERE tenant_id = $1 AND id = $2', [s.tenant_id, row.id, amount]);
    }
    await exec(
      tx,
      `UPDATE app.subscriptions SET pending_plan_id = $3, pending_plan_snapshot = $4::jsonb, pending_effective = $5 WHERE tenant_id = $1 AND id = $2`,
      [s.tenant_id, id, plan.id, JSON.stringify({ ...snapshotOf(plan), termYears: s.plan_snapshot.termYears }), next.period_from],
    );
    await writeAudit(tx, adminActor(ctx.adminId, s.tenant_id), {
      action: 'subscription.change_plan', entity: 'subscription', entityId: id,
      before: { plan: s.plan_snapshot.code }, after: { plan: plan.code, effective: next.period_from }, reason: input.reason,
    }, meta);
    return { tenantId: s.tenant_id };
  });
  await finish(r.tenantId, []);
  return getSubscription(ctx, id);
}

/** SUB-07: cancel early. Future rows are removed, drafts cancelled; issued unpaid invoices kept or credit-noted. */
export async function cancelSubscription(
  ctx: AdminTxCtx, id: string, input: { reason: string; effectiveDate?: string; unpaidInvoices: 'keep' | 'credit_note' }, meta: RequestMeta,
) {
  const today = todayIST();
  const eff = input.effectiveDate ?? today;
  if (eff < today) throw unprocessable('DATE_IN_PAST', 'The effective date cannot be in the past.');
  const r = await withAdmin(ctx, async (tx) => {
    const s = await lockSubscription(tx, id);
    if (!['active', 'scheduled'].includes(s.status)) throw conflict('SUBSCRIPTION_NOT_ACTIVE', 'This subscription is not active.');
    const actor = adminActor(ctx.adminId, s.tenant_id);
    const outbox: Array<string | null> = [];
    const linked = await many<{ invoice_id: string; status: string; period_from: string }>(
      tx,
      `SELECT b.invoice_id, i.status, b.period_from FROM app.billing_schedule b
         JOIN app.invoices i ON i.tenant_id = b.tenant_id AND i.id = b.invoice_id
        WHERE b.tenant_id = $1 AND b.subscription_id = $2`,
      [s.tenant_id, id],
    );
    for (const l of linked) {
      if (l.status === 'draft' || (input.unpaidInvoices === 'credit_note' && ['issued', 'partially_paid', 'overdue'].includes(l.status))) {
        const res = await cancelInvoiceTx(tx, s.tenant_id, l.invoice_id, { reason: `Subscription cancelled: ${input.reason}`, releaseSchedule: false }, actor, today, meta);
        outbox.push(...res.outbox);
      }
    }
    await exec(tx, 'DELETE FROM app.billing_schedule WHERE tenant_id = $1 AND subscription_id = $2 AND invoice_id IS NULL', [s.tenant_id, id]);
    const end = maxDate(eff, s.start_date);
    await exec(
      tx,
      `UPDATE app.subscriptions SET status = 'cancelled', cancelled_at = now(), cancel_reason = $3, end_date = $4,
              pending_plan_id = NULL, pending_plan_snapshot = NULL, pending_effective = NULL
        WHERE tenant_id = $1 AND id = $2`,
      [s.tenant_id, id, input.reason, end],
    );
    await writeAudit(tx, actor, {
      action: 'subscription.cancel', entity: 'subscription', entityId: id,
      before: { endDate: s.end_date, status: s.status }, after: { endDate: end, unpaidInvoices: input.unpaidInvoices }, reason: input.reason,
    }, meta);
    const ev = await evaluateTenant(tx, s.tenant_id, { actor, cause: 'manual', note: 'Subscription cancelled' });
    outbox.push(...ev.outbox);
    return { tenantId: s.tenant_id, outbox };
  });
  await finish(r.tenantId, r.outbox);
  // PDFs of the credit notes this cancellation created
  const cns = await withAdmin(ctx, (tx) => many<{ id: string }>(
    tx,
    `SELECT cn.id FROM app.credit_notes cn
       JOIN app.billing_schedule b ON b.tenant_id = cn.tenant_id AND b.invoice_id = cn.invoice_id
      WHERE b.tenant_id = $1 AND b.subscription_id = $2 AND cn.pdf_key IS NULL`,
    [r.tenantId, id],
  ));
  for (const c of cns) await enqueue(QUEUES.pdfInvoice, { tenantId: r.tenantId, kind: 'credit_note', id: c.id });
  return getSubscription(ctx, id);
}
