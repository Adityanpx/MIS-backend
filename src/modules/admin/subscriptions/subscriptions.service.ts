import { many, maybeOne, one } from '../../../db/sql';
import { withAdmin, type AdminTxCtx, type Tx } from '../../../db/tenant';
import type { PlanSnapshot } from '../../../db/types';
import { notFound } from '../../../lib/errors';
import { sumAmounts } from '../../domain/pricing';

interface SubRow {
  id: string; tenant_id: string; plant_id: string; plan_id: string; plan_snapshot: PlanSnapshot;
  custom_price_per_year: string | null; custom_reason: string | null; start_date: string; end_date: string;
  billing_mode: string; trial_days: number; status: string; created_at: string;
  plant_name: string; plant_code: string; client_name: string; client_code: string;
}
interface ScheduleDbRow {
  id: string; year_no: number; period_from: string; period_to: string; amount: string;
  planned_invoice_date: string; due_date: string; invoice_id: string | null;
}
const SELECT = `
  SELECT s.id, s.tenant_id, s.plant_id, s.plan_id, s.plan_snapshot, s.custom_price_per_year, s.custom_reason,
         s.start_date, s.end_date, s.billing_mode, s.trial_days, s.status, s.created_at,
         p.name AS plant_name, p.code AS plant_code, c.display_name AS client_name, c.code AS client_code
    FROM app.subscriptions s
    JOIN app.plants p ON p.tenant_id = s.tenant_id AND p.id = s.plant_id
    JOIN app.clients c ON c.id = s.tenant_id`;

export function toSubscriptionDto(r: SubRow, schedule?: ScheduleDbRow[]) {
  const sched = schedule?.map((x) => ({
    id: x.id, yearNo: x.year_no, periodFrom: x.period_from, periodTo: x.period_to, amount: x.amount,
    plannedInvoiceDate: x.planned_invoice_date, dueDate: x.due_date, invoiceId: x.invoice_id,
    status: x.invoice_id ? 'invoiced' : 'planned',
  }));
  return {
    id: r.id, clientId: r.tenant_id, clientName: r.client_name, clientCode: r.client_code,
    plantId: r.plant_id, plantName: r.plant_name, plantCode: r.plant_code, planId: r.plan_id, plan: r.plan_snapshot,
    pricePerYear: r.custom_price_per_year ?? r.plan_snapshot.pricePerYear,
    customPricePerYear: r.custom_price_per_year, customReason: r.custom_reason,
    startDate: r.start_date, endDate: r.end_date, billingMode: r.billing_mode, trialDays: r.trial_days,
    status: r.status, createdAt: r.created_at,
    ...(sched ? { schedule: sched, totalExGst: sumAmounts(sched) } : {}),
  };
}
export type SubscriptionDto = ReturnType<typeof toSubscriptionDto>;

export const scheduleRows = (tx: Tx, tenantId: string, subscriptionId: string) =>
  many<ScheduleDbRow>(
    tx,
    `SELECT id, year_no, period_from, period_to, amount, planned_invoice_date, due_date, invoice_id
       FROM app.billing_schedule WHERE tenant_id = $1 AND subscription_id = $2 ORDER BY year_no`,
    [tenantId, subscriptionId],
  );

/** The plant's current subscription (active first, else the next scheduled one), with its schedule. */
export async function currentSubscription(tx: Tx, tenantId: string, plantId: string): Promise<SubscriptionDto | null> {
  const r = await maybeOne<SubRow>(
    tx,
    `${SELECT} WHERE s.tenant_id = $1 AND s.plant_id = $2 AND s.status IN ('active', 'scheduled')
      ORDER BY (s.status = 'active') DESC, s.start_date ASC LIMIT 1`,
    [tenantId, plantId],
  );
  return r ? toSubscriptionDto(r, await scheduleRows(tx, tenantId, r.id)) : null;
}

export async function listSubscriptions(
  ctx: AdminTxCtx,
  q: { page: number; pageSize: number; clientId?: string; plantId?: string; status?: string; endingWithinDays?: number },
) {
  return withAdmin(ctx, async (tx) => {
    const where = `($1::uuid IS NULL OR s.tenant_id = $1)
       AND ($2::uuid IS NULL OR s.plant_id = $2)
       AND ($3::text IS NULL OR s.status = $3)
       AND ($4::int IS NULL OR s.end_date <= (now() AT TIME ZONE 'Asia/Kolkata')::date + $4)`;
    const params = [q.clientId ?? null, q.plantId ?? null, q.status ?? null, q.endingWithinDays ?? null];
    const { total } = await one<{ total: number }>(tx, `SELECT count(*) AS total FROM app.subscriptions s WHERE ${where}`, params);
    const rows = await many<SubRow>(tx, `${SELECT} WHERE ${where} ORDER BY s.end_date ASC LIMIT $5 OFFSET $6`,
      [...params, q.pageSize, (q.page - 1) * q.pageSize]);
    return { items: rows.map((r) => toSubscriptionDto(r)), total };
  });
}

export async function getSubscription(ctx: AdminTxCtx, id: string): Promise<SubscriptionDto> {
  return withAdmin(ctx, async (tx) => {
    const r = await maybeOne<SubRow>(tx, `${SELECT} WHERE s.id = $1`, [id]);
    if (!r) throw notFound('Subscription');
    return toSubscriptionDto(r, await scheduleRows(tx, r.tenant_id, r.id));
  });
}
